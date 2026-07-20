import { useEffect, useState } from 'react';
import { Database, Q } from '@nozbe/watermelondb';
import { useDispatch } from 'react-redux';
import { logout } from '../redux/slices/authSlice';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
 
import { Platform, AppState, AppStateStatus } from 'react-native';
import { secureStore as SecureStore } from '../utils/secureStore';
 
import { localDbSchema, localDbMigrations } from '../db/schema';
import { LocalUser, KnownPeer, Message, SosEvent, LocationLog, SyncQueue } from '../db/models';
import { MobileRepository } from '../db/repository';
 
import { BleScanner } from '../comms/ble/ble-scanner';
import { BleAdvertiser } from '../comms/ble/ble-advertiser';
import { requestBlePermissions } from '../comms/ble/ble-permission-helper';
import { AndroidWifiP2PTransport } from '../comms/wifi-direct/wifi-p2p-transport.android';
import { SecureTransport } from '../comms/secure-transport';
 
import { AuthService } from '../services/AuthService';
import { ChatService } from '../services/ChatService';
import { MapService } from '../services/MapService';
import { SosService } from '../services/SosService';
import { logger, enableFileLogging } from '../utils/logger';
 
export interface Services {
  authService: AuthService;
  chatService: ChatService;
  mapService: MapService;
  sosService: SosService;
  database: Database;
  bleScanner?: BleScanner;
  bleAdvertiser?: BleAdvertiser;
  initTransportsForUser: (user: LocalUser) => Promise<void>;
  shutdownTransports: () => Promise<void>;
}
 
/**
 * One physical Wi-Fi Direct socket + its secure channel wrapper.
 * Before the handshake completes we only know the peer by its Wi-Fi Direct
 * MAC address (`connKey`); once PUBKEY_EXCHANGE arrives we also know its
 * logical deviceId and mirror the entry into ChatService's peer map.
 */
interface PeerConnection {
  connKey: string; // Wi-Fi Direct MAC address, or a synthetic key for the GO's inbound socket
  raw: AndroidWifiP2PTransport;
  secure: SecureTransport;
  deviceId?: string;
  deviceAddress?: string; // MAC address of the remote peer (set when connectToPeer is called)
}
 
export function useInitializeServices() {
  const [services, setServices] = useState<Services | null>(null);
  const dispatch = useDispatch();
 
  useEffect(() => {
    let db: Database;
 
    const initAsync = async () => {
      enableFileLogging(true);
      logger.sys.info('Service bootstrap starting');
      // SQLiteAdapter requires the WMDatabaseBridge native module compiled into the app binary.
      // In Expo Go this native module is absent, so we fall back to the pure-JS LokiJS adapter.
      const { NativeModules } = require('react-native');
      const hasNativeSQLite = !!NativeModules.WMDatabaseBridge;
 
      let adapter;
      if (!hasNativeSQLite || Platform.OS === 'web' || process.env.NODE_ENV === 'test') {
        adapter = new LokiJSAdapter({
          schema: localDbSchema,
          useWebWorker: false,
          useIncrementalIndexedDB: false,
        });
      } else {
        const SQLiteAdapterClass = require('@nozbe/watermelondb/adapters/sqlite').default;
        adapter = new SQLiteAdapterClass({
          schema: localDbSchema,
          migrations: localDbMigrations,
          dbName: 'disaster_p2p_db',
          onSetUpError: (error: any) => logger.db.error('WatermelonDB SQLite setup failed', { error: String(error) }),
        });
      }
 
      db = new Database({
        adapter,
        modelClasses: [LocalUser, KnownPeer, Message, SosEvent, LocationLog, SyncQueue],
      });
 
      // 2. Initialize Services
      const authService = new AuthService(db);
      const chatService = new ChatService(db);
      const mapService = new MapService(db);
      const sosService = new SosService(db, chatService);
 
      // Link ChatService to MapService for location sharing
      mapService.setChatService(chatService);
 
      // Initialize Wifi Direct static layer at startup
      AndroidWifiP2PTransport.initialize().catch((err) => {
        logger.p2p.warn('Failed to initialize static Wi-Fi Direct', { error: String(err) });
      });
 
      // Context state holders for dynamic P2P setup
      let currentAdvertiser: BleAdvertiser | undefined;
      let currentScanner: BleScanner | undefined;
      let unsubConnectionInfo: (() => void) | null = null;
      let unsubPeersChanged: (() => void) | null = null;
 
      // â”€â”€ Multi-peer connection pools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Every connected/connecting peer gets its own PeerConnection, keyed by
      // Wi-Fi Direct MAC address first, then mirrored by deviceId once the
      // handshake reveals it. This replaces the old single
      // `currentRawTransport` / `currentSecureTransport` variables, which
      // meant the app could only ever track ONE peer connection: as soon as
      // device B connected, the guards below treated "a connection exists"
      // as "ignore everyone else," so device C's handshake never started.
      const connectionsByKey = new Map<string, PeerConnection>();
      const connectingKeys = new Set<string>();
 
      // A device can only be a *client* of one Wi-Fi Direct group at a time
      // (an OS-level constraint, not a bug) â€” but if it's the *group owner*,
      // more devices can still join that same group. Track which role we're
      // in so we know whether it's even valid to attempt another connection.
      let groupRole: 'unassigned' | 'owner' | 'client' = 'unassigned';
      let serverSocketBound = false;
      // Tracks the MAC of the peer we most recently called connectToPeer() for.
      // Used to populate entry.deviceAddress before the handshake reveals the logical deviceId.
      let lastTargetMacAddress: string | null = null;
      // â”€â”€ BLE-first peer ID resolution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Maps display name (lower-cased) â†’ live BLE-discovered deviceId.
      // This is the authoritative source for the initiator check in onPeersChanged.
      // It is always more up-to-date than known_peers (which can hold stale IDs
      // from previous installs / account resets â€” the root cause of the initiator
      // deadlock where both devices computed isInitiator=false).
      const bleDiscoveredIds = new Map<string, string>();
      // Periodic discovery retry â€” re-triggers discoverPeers() if we know about
      // BLE peers but no Wi-Fi Direct group has formed yet. Handles the case
      // where onPeersChanged never fires because the two devices weren't in the
      // same discovery window simultaneously.
      let discoveryRetryTimer: ReturnType<typeof setInterval> | null = null;
 
      /**
       * Wires up a raw transport + its SecureTransport wrapper with all the
       * message/handshake/disconnect handling that used to live inline
       * against the single `currentSecureTransport`. Used for both the
       * group-owner's inbound socket and a client's outbound socket.
       */
      const performP2PCleanup = async (context: string) => {
        logger.p2p.info(`P2P cleanup starting (${context})`);
        connectingKeys.clear();
        try {
          await AndroidWifiP2PTransport.cancelConnect();
        } catch (e) {
          logger.p2p.warn('cancelConnect failed', { error: String(e) });
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        
        try {
          await AndroidWifiP2PTransport.clearPersistentGroups();
        } catch (e) {
          logger.p2p.warn('clearPersistentGroups failed', { error: String(e) });
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await AndroidWifiP2PTransport.removeGroup();
            logger.p2p.debug(`removeGroup succeeded on attempt ${attempt}`);
            break;
          } catch (err: any) {
            logger.p2p.warn(`removeGroup attempt ${attempt} failed`, { error: String(err) });
            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 600));
            }
          }
        }
      };

      const setupPeerConnection = (
        connKey: string,
        raw: AndroidWifiP2PTransport,
        secure: SecureTransport,
        localDeviceId: string
      ): PeerConnection => {
        const entry: PeerConnection = { connKey, raw, secure };
        connectionsByKey.set(connKey, entry);
        chatService.registerSecureTransport(secure);
 
        secure.receive(async (plaintext) => {
          try {
            const payload = JSON.parse(plaintext);
            logger.p2p.debug(`[${connKey}] Encrypted payload decrypted, type=${payload?.type || 'unknown'}`);
 
            const remoteId = secure.getRemoteDeviceId();
            if (remoteId) {
              chatService.updateTransportActivity(remoteId);
            }
 
            // â”€â”€ Hub Relay Logic â”€â”€
            // If the message is a chat or ack directed at another device, or is a broadcast type (location_share, sos),
            // and we are the group owner (so we have other active transports), we act as a relay hub.
            let isForMe = true;
            let relayToId: string | null = null;
            let isBroadcast = false;

            if (payload.type === 'chat' || payload.type === 'chat_file_start' || payload.type === 'chat_file_chunk' || payload.type === 'chat_file_end') {
              isForMe = payload.recipientId === localDeviceId;
              if (!isForMe) {
                relayToId = payload.recipientId;
              }
            } else if (payload.type === 'ack') {
              isForMe = payload.senderId === localDeviceId;
              if (!isForMe) {
                relayToId = payload.senderId;
              }
            } else if (payload.type === 'location_share' || payload.type === 'sos') {
              isBroadcast = true;
            }

            if (relayToId) {
              logger.p2p.debug(`Hub relay: forwarding ${payload.type} to peer ${relayToId}`);
              const targetTransport = chatService.getActiveTransport(relayToId);
              if (targetTransport && targetTransport.isHandshakeComplete()) {
                try {
                  await targetTransport.send(plaintext);
                } catch (err) {
                  logger.p2p.warn(`Hub relay failed to forward to ${relayToId}`, { error: String(err) });
                }
              }
              // Do not process locally
              return;
            }

            if (isBroadcast) {
              // Relay broadcast to all other active transports
              const allTransports = chatService.getAllActiveTransports();
              allTransports.forEach(async (t, pId) => {
                if (pId !== payload.senderId && t.isHandshakeComplete()) {
                  try {
                    await t.send(plaintext);
                  } catch (err) {
                    logger.p2p.warn(`Hub relay failed to forward broadcast to ${pId}`, { error: String(err) });
                  }
                }
              });
            }

            if (payload.type === 'chat') {
              logger.p2p.debug('Received chat message payload', { id: payload.id, senderId: payload.senderId });
              await chatService.handleIncomingMessage(payload);
            } else if (payload.type === 'chat_file_start' || payload.type === 'chat_file_chunk' || payload.type === 'chat_file_end') {
              await chatService.handleIncomingFilePayload(payload);
            } else if (payload.type === 'location_share') {
              const peersRepo = new MobileRepository(db);
              await peersRepo.updatePeerLocation(payload.senderId, payload.lat, payload.lng);
              logger.p2p.debug(`Received location share from ${payload.senderId}`, { lat: payload.lat, lng: payload.lng });
            } else if (payload.type === 'sos') {
              logger.sos.debug('Received SOS event payload', { id: payload.id, reporterId: payload.reporterId, severity: payload.severity });
              await sosService.handleIncomingSos(payload);
            } else if (payload.type === 'ping') {
              try {
                const localUser = await new MobileRepository(db).getLocalUser();
                const myId = localUser ? (localUser._raw as any).device_id : localDeviceId;
                const pongPayload = { type: 'pong', senderId: myId, timestamp: Date.now() };
                await secure.send(JSON.stringify(pongPayload));
              } catch (err) {
                logger.p2p.warn('Failed sending pong response', { error: String(err) });
              }
            } else if (payload.type === 'pong') {
              // Activity already updated above
            } else if (payload.type === 'ack') {
              logger.p2p.debug(`Received delivery ack for message ${payload.messageId}`);
              await chatService.markMessageDelivered(payload.messageId);
            }
          } catch (err) {
            logger.p2p.error('Error handling incoming secure packet', { error: String(err) });
          }
        });
 
        secure.onHandshakeReady(async () => {
          const remoteId = secure.getRemoteDeviceId();
          const remoteKey = secure.getRemotePublicKey();
          const remoteName = secure.getRemoteDisplayName();
          if (remoteId) {
            logger.p2p.info(`[${connKey}] Handshake completed, registering transport for peer ${remoteId}`);
            entry.deviceId = remoteId;
            chatService.registerActiveTransport(remoteId, secure);
            connectingKeys.delete(connKey);
            if (groupRole === 'client') {
              connectingKeys.clear();
            }
 
            const peersRepo = new MobileRepository(db);
            await peersRepo.addNewPeer({
              deviceId: remoteId,
              publicKey: remoteKey || '',
              role: 'user',
              trustStatus: 'trusted',
              displayName: remoteName || undefined
            });
 
            try {
              const latestLoc = await db.get<LocationLog>('location_log')
                .query(
                  Q.where('device_id', localDeviceId),
                  Q.sortBy('timestamp', Q.desc),
                  Q.take(1)
                ).fetch();
 
              if (latestLoc.length > 0) {
                const loc = latestLoc[0]._raw as any;
                const payload = {
                  type: 'location_share',
                  senderId: localDeviceId,
                  lat: loc.lat,
                  lng: loc.lng,
                  timestamp: Date.now()
                };
                await secure.send(JSON.stringify(payload));
                logger.p2p.debug('Shared initial coordinates with remote peer');
              }
            } catch (err) {
              logger.p2p.warn('Failed sending initial location sharing packet', { error: String(err) });
            }
          }
        });
 
        raw.onDisconnect(() => {
          const remoteId = entry.deviceId ?? secure.getRemoteDeviceId();
          if (remoteId) {
            logger.p2p.info(`[${connKey}] TCP socket disconnected, unregistering transport for ${remoteId}`);
            chatService.unregisterActiveTransport(remoteId);
          }
          chatService.unregisterSecureTransport(secure);
          connectionsByKey.delete(connKey);
          // Also delete by MAC address in case the connKey is the GO synthetic key
          if (entry.deviceAddress) {
            connectionsByKey.delete(entry.deviceAddress);
            connectingKeys.delete(entry.deviceAddress);
          }
          connectingKeys.delete(connKey);

          if (connectionsByKey.size === 0) {
            connectingKeys.clear();
            // â”€â”€ Critical Reset â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            // When ALL connections are gone we must fully reset the Wi-Fi Direct
            // group state. Without this reset the group owner never re-opens its
            // server socket (serverSocketBound stays true) and subsequent
            // connection attempts fail silently â€” this was the root cause of the
            // handshake not completing after an initial disconnect.
            serverSocketBound = false;
            groupRole = 'unassigned';
            logger.p2p.info('All connections gone, resetting group state and triggering P2P cleanup');
            performP2PCleanup('All Clients Disconnected').catch((err) =>
              logger.p2p.warn('performP2PCleanup after full disconnect failed', { error: String(err) })
            );
          } else if (groupRole === 'client') {
            // Only the client role is exclusive to one group; losing our one
            // client connection frees us up to look for (or accept) another.
            groupRole = 'unassigned';
          }

          logger.p2p.debug(`[${connKey}] Disconnected, triggering re-discovery`);
          AndroidWifiP2PTransport.discoverPeers().catch((err) =>
            logger.p2p.warn('Re-discovery after disconnect failed', { error: String(err) })
          );
        });
 
        return entry;
      };
 
      /**
       * Dynamic initialization of BLE and Wi-Fi Direct transports once identity is loaded.
       */
      const initTransportsForUser = async (user: LocalUser) => {
        const deviceId = (user._raw as any).device_id as string;
        const role = (user._raw as any).role as any;
        const publicKey = (user._raw as any).public_key as string;
        const privateKey = await SecureStore.getItemAsync(`private_key_${deviceId}`);
 
        if (!privateKey) {
          logger.auth.warn('Private key not found in SecureStore, session corrupted, logging out');
          await authService.logout();
          dispatch(logout());
          return;
        }
 
        logger.p2p.info(`Initializing transports for user ${deviceId.substring(0, 8)}`);
 
        // Reset per-session state
        connectingKeys.clear();
        groupRole = 'unassigned';
        serverSocketBound = false;
 
        // TDOWN: Always remove/disconnect any pre-existing native Wi-Fi Direct groups first!
        await performP2PCleanup('Bootstrap');
 
        // Request Bluetooth permissions before starting advertising/scanning
        const permissionsGranted = await requestBlePermissions();
        if (!permissionsGranted) {
          logger.p2p.warn('Bluetooth permissions not granted, cannot start advertising or scanning');
          return;
        }
 
        // Stop any old transports
        if (currentAdvertiser) await currentAdvertiser.stopAdvertising();
        if (currentScanner) currentScanner.stopScanning();
        for (const entry of Array.from(connectionsByKey.values())) {
          await entry.raw.disconnect().catch(() => {});
        }
        connectionsByKey.clear();
 
        const displayName = (user._raw as any).display_name || 'Peer';
 
        // Instantiate Phase 2 BLE scanning & advertising
        const pubKeyHash = publicKey.slice(0, 8); // 4-byte hash (8 hex chars)
        currentAdvertiser = new BleAdvertiser(deviceId, role, pubKeyHash, displayName);
        try {
          await currentAdvertiser.startAdvertising();
        } catch (err) {
          logger.ble.warn('Failed to start BLE advertising', { error: String(err) });
        }
 
        // â”€â”€ Wire up Wi-Fi Direct Group formation listeners â”€â”€
        unsubConnectionInfo = AndroidWifiP2PTransport.onConnectionInfo(async (info) => {
          logger.p2p.debug('Connection Info Event received', { groupFormed: info.groupFormed, isGroupOwner: info.isGroupOwner, ownerAddr: info.groupOwnerAddress });
          if (info.groupFormed) {
            let ownerAddress = info.groupOwnerAddress;
            const isOwner = info.isGroupOwner;
 
            if (isOwner) {
              groupRole = 'owner';
              if (serverSocketBound) {
                // NATIVE TODO: the current native bridge (WifiDirectTcpConnected /
                // WifiDirectTcpData) models exactly one accepted socket with no
                // per-connection ID. Re-opening here is skipped to avoid
                // clobbering an existing connection, but a genuinely concurrent
                // 3rd/4th client requires the native module to accept() in a
                // loop and tag events with a connection id â€” that change has
                // to happen in the (currently missing from this repo) Kotlin
                // WifiDirect module.
                logger.p2p.debug('Server socket already bound, skipping duplicate openServerSocket');
                return;
              }
              logger.p2p.info('I am Group Owner, opening TCP server socket on port 8888');
              try {
                const raw = new AndroidWifiP2PTransport(deviceId);
                const secure = new SecureTransport(raw, privateKey, publicKey, deviceId, displayName);
                const connKey = `owner-socket-${Date.now()}`;
                const ownerEntry = setupPeerConnection(connKey, raw, secure, deviceId);
                // Store the MAC of the client that just connected (captured by lastTargetMacAddress
                // on the other side). On the server side we don't know the client MAC until the
                // handshake completes, so we store nothing here â€” that's fine; the connKey is
                // unique enough for the owner's inbound socket lifetime.
                void ownerEntry;
 
                raw.onConnect(async () => {
                  logger.p2p.debug(`[${connKey}] TCP Server received client connection, initiating handshake`);
                  try {
                    await secure.establishHandshake();
                  } catch (err) {
                    logger.p2p.error('Failed establishing handshake on client connect', { error: String(err) });
                  }
                });
 
                await raw.openServerSocket(8888);
                serverSocketBound = true;
                logger.p2p.info('TCP ServerSocket bound and listening on port 8888');
              } catch (err) {
                logger.p2p.error('openServerSocket failed', { error: String(err) });
              }
            } else {
              groupRole = 'client';
              const connKey = ownerAddress || 'pending-owner';
 
              if (connectionsByKey.has(connKey) || connectingKeys.has(connKey)) {
                logger.p2p.debug(`Already connected/connecting to owner ${connKey}, ignoring duplicate event`);
                return;
              }
 
              // Resolve empty owner address by fetching updated connection info with backoff
              if (!ownerAddress || ownerAddress === '') {
                logger.p2p.debug('Group Owner Address is empty, retrying connection info fetch');
                for (let attempt = 1; attempt <= 5; attempt++) {
                  await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
                  try {
                    const updatedInfo = await AndroidWifiP2PTransport.getConnectionInfo();
                    logger.p2p.debug(`Attempt ${attempt} connection info fetch`, { result: updatedInfo });
                    if (updatedInfo.groupOwnerAddress && updatedInfo.groupOwnerAddress !== '') {
                      ownerAddress = updatedInfo.groupOwnerAddress;
                      break;
                    }
                  } catch (err) {
                    logger.p2p.warn(`Attempt ${attempt} to fetch connection info failed`, { error: String(err) });
                  }
                }
              }
 
              logger.p2p.info('I am Client, targeting Group Owner', { ownerAddress });
              if (!ownerAddress || ownerAddress === '') {
                logger.p2p.error('Group Owner Address remains empty after retries, resetting P2P group');
                groupRole = 'unassigned';
                await performP2PCleanup('Client Empty GO IP');
                return;
              }
 
              const finalKey = ownerAddress;
              connectingKeys.add(finalKey);
 
              const raw = new AndroidWifiP2PTransport(deviceId);
              const secure = new SecureTransport(raw, privateKey, publicKey, deviceId, displayName);
              const clientEntry = setupPeerConnection(finalKey, raw, secure, deviceId);
              // Populate the MAC address for proper disconnect-key cleanup
              if (lastTargetMacAddress) {
                clientEntry.deviceAddress = lastTargetMacAddress;
              }
 
              // Retry with exponential backoff: 500ms, 1s, 2s, 4s, 8s
              let delay = 500;
              let connected = false;
              for (let attempt = 1; attempt <= 5 && !connected; attempt++) {
                try {
                  await new Promise((resolve) => setTimeout(resolve, delay));
                  logger.p2p.debug(`TCP connection attempt ${attempt}/5 to ${ownerAddress}:8888`);
                  await raw.connectToSocket(ownerAddress, 8888);
                  connected = true;
                  logger.p2p.info('TCP socket connected successfully');
                  logger.p2p.info('Client establishing secure transport handshake');
                  await secure.establishHandshake();
                } catch (err: any) {
                  delay = Math.min(delay * 2, 32000);
                  logger.p2p.warn(`Attempt ${attempt}/5 failed`, { error: String(err.message || err), nextRetryIn: `${delay / 1000}s` });
                  if (attempt === 5) {
                    logger.p2p.error('Max connection retries reached, Group Owner unreachable, resetting P2P group');
                    groupRole = 'unassigned';
                    connectingKeys.delete(finalKey);
                    connectionsByKey.delete(finalKey);
                    await performP2PCleanup('Client Retry Max Failure');
                  }
                }
              }
            }
          } else {
            logger.p2p.debug('Group not formed (groupFormed=false), resetting connection flags');
            serverSocketBound = false;
            groupRole = 'unassigned';
            connectingKeys.clear();
          }
        });
 
        unsubPeersChanged = AndroidWifiP2PTransport.onPeersChanged(async (peers) => {
          logger.p2p.debug('Wi-Fi Direct peers changed', { count: peers.length });
 
          // A device already committed as a CLIENT of another group cannot
          // also connect out to a second peer â€” that's a real Wi-Fi Direct
          // constraint. But being the GROUP OWNER (or unassigned) should NOT
          // stop us from inviting additional available peers in.
          if (groupRole === 'client') {
            logger.p2p.debug('Already a client of another group, ignoring peers list');
            return;
          }
 
          const isAlreadyConnectedOrConnecting = (pAddress: string, pName: string): boolean => {
            if (connectingKeys.has(pAddress) || connectionsByKey.has(pAddress)) {
              return true;
            }
            const connections = Array.from(connectionsByKey.values());
            const hasMatchingConnection = connections.some((conn) => {
              if (conn.connKey === pAddress) return true;
              const remoteName = conn.secure.getRemoteDisplayName();
              if (remoteName && pName.toLowerCase().includes(remoteName.toLowerCase())) {
                return true;
              }
              return false;
            });
            return hasMatchingConnection;
          };
 
          // Find peers that are AVAILABLE (status 3) and not already
          // connected or mid-connection â€” this is now checked PER PEER
          // instead of via a single global "is anyone connected" flag, so
          // discovering a 3rd/4th device no longer gets silently dropped
          // just because we already have one active connection.
          const candidates = peers.filter((p) =>
            p.status === 3 &&
            !isAlreadyConnectedOrConnecting(p.deviceAddress, p.deviceName)
          );

          if (candidates.length === 0) {
            logger.p2p.debug('No new AVAILABLE peers to connect to');
            return;
          }

          // Initiator check: BLE-first resolution
          // Priority:
          //   1. live bleDiscoveredIds map  (never stale)
          //   2. MAC-address lexicographic fallback
          // known_peers DB is NOT used here: stale device_ids cause isInitiator=false deadlock.
          let candidateToConnect: typeof candidates[0] | null = null;

          for (const c of candidates) {
            // 1. Live BLE map lookup — collision-safe compound key.
            //
            // BLE advertiser broadcasts local name "DP2P:Maryam:4ba05e47".
            // We store bleDiscoveredIds with key "maryam:4ba05e47" -> fullDeviceId.
            //
            // Wi-Fi Direct shows "Maryam's A32". Extract the first word
            // ("maryam") then scan the map for ALL keys starting with
            // "maryam:" — gives us a list of candidates by that name.
            // If there is exactly one, use it. If multiple (name collision),
            // fall through to the name-based fallback.
            const wifiName = c.deviceName;
            const firstWordKey = wifiName.split(/['\s]/)[0].toLowerCase();
            const blePrefix = firstWordKey + ':';

            // Gather all BLE-map entries whose key starts with this prefix
            const bleMatches: string[] = [];
            for (const [key, val] of bleDiscoveredIds.entries()) {
              if (key.startsWith(blePrefix)) bleMatches.push(val);
            }

            if (bleMatches.length === 1) {
              // Unambiguous: exactly one BLE peer with this first name
              const bleRemoteId = bleMatches[0];
              const isInitiator = deviceId < bleRemoteId;
              logger.p2p.debug(`Candidate '${wifiName}' resolved via BLE map`, { bleRemoteId: bleRemoteId.substring(0, 8), isInitiator });
              if (isInitiator) {
                candidateToConnect = c;
                break;
              }
              continue;
            } else if (bleMatches.length > 1) {
              logger.p2p.debug(`Candidate '${wifiName}' has ${bleMatches.length} BLE matches (name collision), falling to name fallback`);
            }

            // 2. Name-based fallback — symmetric & collision-safe.
            // Compare the first word of our own display name with the
            // first word of the Wi-Fi Direct peer name. Lower name wins.
            const localFirstWord = displayName.split(/['\s]/)[0].toLowerCase();
            let isInitiatorFallback: boolean;
            if (localFirstWord !== firstWordKey) {
              isInitiatorFallback = localFirstWord < firstWordKey;
            } else {
              // True name collision: fall back to MAC / UUID comparison
              const localMac = AndroidWifiP2PTransport.localMacAddress?.toLowerCase() || deviceId.toLowerCase();
              isInitiatorFallback = localMac < c.deviceAddress.toLowerCase();
            }
            logger.p2p.debug(`Candidate '${wifiName}' name fallback`, { local: localFirstWord, remote: firstWordKey, isInitiator: isInitiatorFallback });
            if (isInitiatorFallback) {
              candidateToConnect = c;
              break;
            }
          }

          if (!candidateToConnect) {
            logger.p2p.debug('Not the initiator for any available candidate peer, waiting for them to connect');
            return;
          }

          connectingKeys.add(candidateToConnect.deviceAddress);
          // Remember the MAC so setupPeerConnection can populate entry.deviceAddress
          lastTargetMacAddress = candidateToConnect.deviceAddress;
          logger.p2p.info('Selected target peer for Wi-Fi Direct connection', { name: candidateToConnect.deviceName, address: candidateToConnect.deviceAddress });
          try {
            await AndroidWifiP2PTransport.connectToPeer(candidateToConnect.deviceAddress);
            logger.p2p.debug('Native connectToPeer resolved, waiting for Group Formation');
          } catch (err: any) {
            logger.p2p.error('connectToPeer failed', { error: String(err) });
            connectingKeys.delete(candidateToConnect.deviceAddress);
            
            // Only perform cleanup if we are still unassigned and no active/connecting key exists
            if (groupRole === 'unassigned' && connectionsByKey.size === 0 && connectingKeys.size === 0) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
              // Double check after delay to prevent race conditions
              if (groupRole === 'unassigned' && connectionsByKey.size === 0 && connectingKeys.size === 0) {
                await performP2PCleanup('Initiator Connect Failure');
              }
            }
          }
        });
 
        let lastDiscoverTime = 0;
        const scannedPeersCache = new Set<string>();
 
        // Wire up BLE discovery callback
        currentScanner = new BleScanner(async (peerDevice) => {
          if (!scannedPeersCache.has(peerDevice.deviceId)) {
            scannedPeersCache.add(peerDevice.deviceId);
            try {
              const peersRepo = new MobileRepository(db);
              const exists = await peersRepo.getPeer(peerDevice.deviceId);
              if (!exists) {
                logger.p2p.debug(`First time seeing peer ${peerDevice.deviceId.substring(0, 8)} via BLE, adding to local DB`);
                await peersRepo.addNewPeer({
                  deviceId: peerDevice.deviceId,
                  publicKey: peerDevice.publicKeyHash,
                  role: peerDevice.role,
                  trustStatus: 'pending',
                  displayName: peerDevice.displayName
                });
              } else if (!(exists._raw as any).display_name && peerDevice.displayName) {
                await peersRepo.addNewPeer({
                  deviceId: peerDevice.deviceId,
                  publicKey: peerDevice.publicKeyHash,
                  role: peerDevice.role,
                  trustStatus: (exists._raw as any).trust_status,
                  displayName: peerDevice.displayName
                });
              }
            } catch (err) {
              logger.p2p.warn('Failed to query/add new BLE peer to DB', { error: String(err) });
              scannedPeersCache.delete(peerDevice.deviceId);
            }
          }
 
          mapService.updatePeerRssi(peerDevice.deviceId, peerDevice.rssi);
 
          // ── Update live BLE-first resolution map ─────────────────────────────
          // Store the deviceId keyed by multiple name variants so onPeersChanged
          // can reliably match regardless of the Wi-Fi Direct device name format.
          if (peerDevice.displayName) {
            // Use compound key "firstWord:idPrefix" (e.g. "maryam:4ba05e47")
            // so multiple users with the same first name don't collide.
            const firstWord = peerDevice.displayName.split(/['\s]/)[0].toLowerCase();
            const idPrefix = peerDevice.deviceId.substring(0, 8).toLowerCase();
            const compoundKey = `${firstWord}:${idPrefix}`;
            bleDiscoveredIds.set(compoundKey, peerDevice.deviceId);
            logger.p2p.debug(`BLE map updated: '${compoundKey}' => ${peerDevice.deviceId.substring(0, 8)}`);
          }

          // Same fix as onPeersChanged: only skip discovery for a peer we're
          // already connected/connecting to (or if we're locked as a client
          // elsewhere) â€” not just because *some* connection exists.
          const alreadyConnected = connectionsByKey.has(peerDevice.deviceId) ||
            Array.from(connectionsByKey.values()).some((c) => c.deviceId === peerDevice.deviceId);
 
          if (groupRole !== 'client' && !alreadyConnected) {
            logger.p2p.debug(`BLE scanned peer ${peerDevice.deviceId.substring(0, 8)}, my ID ${deviceId.substring(0, 8)}`);
 
            const now = Date.now();
            if (now - lastDiscoverTime > 5000) {
              lastDiscoverTime = now;
              logger.p2p.debug('Triggering native Wi-Fi Direct peer discovery (throttled)');
              try {
                await AndroidWifiP2PTransport.discoverPeers();
              } catch (err) {
                logger.p2p.warn('discoverPeers failed', { error: String(err) });
              }
            }
          }
        });
 
        // â”€â”€ Periodic discovery retry timer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // If onPeersChanged never fires (devices not in same discovery window),
        // re-trigger discoverPeers every 30s while we're unassigned and have
        // at least one BLE-discovered peer we haven't connected to yet.
        if (discoveryRetryTimer) clearInterval(discoveryRetryTimer);
        discoveryRetryTimer = setInterval(async () => {
          if (groupRole !== 'unassigned' || bleDiscoveredIds.size === 0) return;
          const hasUnconnectedBlePeer = Array.from(bleDiscoveredIds.values()).some(
            (id) => !Array.from(connectionsByKey.values()).some((conn) => conn.deviceId === id)
          );
          if (!hasUnconnectedBlePeer) return;
          logger.p2p.debug('Retry timer: still unassigned with known BLE peers, re-triggering discoverPeers');
          try {
            await AndroidWifiP2PTransport.discoverPeers();
          } catch (err) {
            logger.p2p.warn('Retry discoverPeers failed', { error: String(err) });
          }
        }, 30000);
 
        try {
          currentScanner.startScanning();
        } catch (err) {
          logger.ble.warn('Failed to start BLE scanning', { error: String(err) });
        }
      };
 
      /**
       * Shuts down all active BLE advertisements, scanners, and socket streams.
       */
      const shutdownTransports = async () => {
        logger.p2p.info('Shutting down transport protocols');
        if (discoveryRetryTimer) {
          clearInterval(discoveryRetryTimer);
          discoveryRetryTimer = null;
        }
        if (unsubConnectionInfo) {
          unsubConnectionInfo();
          unsubConnectionInfo = null;
        }
        if (unsubPeersChanged) {
          unsubPeersChanged();
          unsubPeersChanged = null;
        }
        if (currentAdvertiser) {
          await currentAdvertiser.stopAdvertising();
          currentAdvertiser = undefined;
        }
        if (currentScanner) {
          currentScanner.destroy();
          currentScanner = undefined;
        }
        for (const entry of Array.from(connectionsByKey.values())) {
          await entry.raw.disconnect().catch(() => {});
          chatService.unregisterSecureTransport(entry.secure);
        }
        connectionsByKey.clear();
        connectingKeys.clear();
        groupRole = 'unassigned';
        serverSocketBound = false;
        // Stop the heartbeat timer in ChatService
        chatService.destroy();
      };
 
      // 3. Auto-Login Recovery Checks
      const existingUser = await authService.getCurrentUser();
      if (existingUser) {
        await initTransportsForUser(existingUser);
      }
 
      setServices({
        authService,
        chatService,
        mapService,
        sosService,
        database: db,
        initTransportsForUser,
        shutdownTransports
      });
    };
 
    let cleanupTransports: (() => Promise<void>) | null = null;
    let initTransportsRef: ((user: LocalUser) => Promise<void>) | null = null;
    let servicesRef: typeof services | null = null;
 
    initAsync().catch((error) => {
      logger.sys.error('Failed to bootstrap services', { error: String(error) });
    });
 
    // Capture refs for AppState handler after services are initialized
    const servicesUpdateUnsub = setInterval(() => {
      setServices((prev) => {
        if (prev && !cleanupTransports) {
          cleanupTransports = prev.shutdownTransports;
          initTransportsRef = prev.initTransportsForUser;
          servicesRef = prev;
        }
        return prev;
      });
    }, 500);
 
    // ENHANCEMENT 7: AppState handler disabled for background P2P reliability
    const handleAppStateChange = async (nextState: AppStateStatus) => {
      logger.sys.debug(`AppState transition to ${nextState} (transports kept active)`);
    };
 
    const appStateSub = AppState.addEventListener('change', handleAppStateChange);
 
    return () => {
      clearInterval(servicesUpdateUnsub);
      appStateSub.remove();
      // Tear down all BLE and Wi-Fi Direct resources on unmount
      if (cleanupTransports) {
        cleanupTransports().catch((err) =>
          logger.p2p.warn('Cleanup on unmount failed', { error: String(err) })
        );
      }
    };
  }, []);
 
  return services;
}

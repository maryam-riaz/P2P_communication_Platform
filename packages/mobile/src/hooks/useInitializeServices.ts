import { useEffect, useState } from 'react';
import { Database, Q } from '@nozbe/watermelondb';
import { useDispatch } from 'react-redux';
import { logout } from '../redux/slices/authSlice';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';

import { Platform, AppState, AppStateStatus } from 'react-native';
import * as Location from 'expo-location';
import { secureStore as SecureStore } from '../utils/secureStore';

import { localDbSchema, localDbMigrations } from '../db/schema';
import { LocalUser, KnownPeer, Message, SosEvent, LocationLog, SyncQueue } from '../db/models';
import { MobileRepository } from '../db/repository';

import { startScanning, stopScanning, cleanupBleScanner } from '../comms/ble/ble-scanner';
import { initializeBleManager } from '../comms/ble/shared-ble-manager';
import { PeerRegistry } from '../services/PeerRegistry';
import { BleAdvertiser } from '../comms/ble/ble-advertiser';
import { requestP2pPermissions } from '../comms/ble/ble-permission-helper';
import { AndroidWifiP2PTransport } from '../comms/wifi-direct/wifi-p2p-transport.android';
import { SecureTransport } from '../comms/secure-transport';

import { AuthService } from '../services/AuthService';
import { ChatService } from '../services/ChatService';
import { MapService } from '../services/MapService';
import { SosService } from '../services/SosService';

export interface Services {
  authService: AuthService;
  chatService: ChatService;
  mapService: MapService;
  sosService: SosService;
  database: Database;
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
  scheduleHandshakeRecovery: () => void;
  clearHandshakeRecovery: () => void;
}

export function useInitializeServices() {
  const [services, setServices] = useState<Services | null>(null);
  const dispatch = useDispatch();

  useEffect(() => {
    let db: Database;

    const initAsync = async () => {
      // SQLiteAdapter requires the WMDatabaseBridge native module compiled into the app binary.
      // In Expo Go this native module is absent, so we fall back to the pure-JS LokiJS adapter.
      const { NativeModules } = require('react-native');
      const hasNativeSQLite = !!NativeModules.WMDatabaseBridge;

      let adapter;
      if (!hasNativeSQLite || Platform.OS === 'web' || process.env.NODE_ENV === 'test') {
        adapter = new LokiJSAdapter({
          schema: localDbSchema,
          useWebWorker: false,
        });
      } else {
        const SQLiteAdapterClass = require('@nozbe/watermelondb/adapters/sqlite').default;
        adapter = new SQLiteAdapterClass({
          schema: localDbSchema,
          migrations: localDbMigrations,
          dbName: 'disaster_p2p_db',
          onSetUpError: (error: any) => console.error('WatermelonDB SQLite setup failed:', error),
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
        console.warn('[P2P Bootstrap] Failed to initialize static Wi-Fi Direct:', err);
      });

      // Context state holders for dynamic P2P setup
      let currentAdvertiser: BleAdvertiser | undefined;
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
      let groupFormationTimeout: ReturnType<typeof setTimeout> | null = null;

      /**
       * Wires up a raw transport + its SecureTransport wrapper with all the
       * message/handshake/disconnect handling that used to live inline
       * against the single `currentSecureTransport`. Used for both the
       * group-owner's inbound socket and a client's outbound socket.
       */
      const performP2PCleanup = async (context: string) => {
        console.log(`[P2P Cleanup - ${context}] Starting robust P2P cleanup sequence...`);
        connectingKeys.clear();
        try {
          await AndroidWifiP2PTransport.cancelConnect();
        } catch (e) {
          console.warn(`[P2P Cleanup] cancelConnect failed:`, e);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));

        try {
          await AndroidWifiP2PTransport.clearPersistentGroups();
        } catch (e) {
          console.warn(`[P2P Cleanup] clearPersistentGroups failed:`, e);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));

        try {
          const info = await AndroidWifiP2PTransport.getConnectionInfo();
          if (!info.groupFormed) {
             console.log(`[P2P Cleanup] No Wi-Fi Direct group formed, skipping removeGroup.`);
             return;
          }
        } catch (e) {
          console.warn(`[P2P Cleanup] Failed to check connection info:`, e);
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await AndroidWifiP2PTransport.removeGroup();
            console.log(`[P2P Cleanup] removeGroup succeeded on attempt ${attempt}.`);
            break;
          } catch (err: any) {
            console.warn(`[P2P Cleanup] removeGroup attempt ${attempt} failed:`, err);
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
        let handshakeRecoveryTimer: ReturnType<typeof setInterval> | null = null;
        const clearHandshakeRecovery = () => {
          if (handshakeRecoveryTimer) {
            clearInterval(handshakeRecoveryTimer);
            handshakeRecoveryTimer = null;
          }
        };
        const scheduleHandshakeRecovery = () => {
          clearHandshakeRecovery();
          // Watchdog only — SecureTransport handles its own retry internally.
          // This interval self-cleans when the handshake completes or the
          // raw transport disconnects, preventing stale timers.
          handshakeRecoveryTimer = setInterval(() => {
            if (secure.isHandshakeComplete() || !raw.isConnected()) {
              clearHandshakeRecovery();
            }
          }, 5000);
        };

        const entry: PeerConnection = {
          connKey,
          raw,
          secure,
          scheduleHandshakeRecovery,
          clearHandshakeRecovery,
        };
        connectionsByKey.set(connKey, entry);
        chatService.registerSecureTransport(secure);

        secure.receive((plaintext) => {
          // Defer all heavy processing off the critical JS thread to prevent
          // UI freezes during rapid message arrival (e.g. file chunks).
          // The actual parsing, DB writes, and relay sends happen on the
          // next microtask/macrotask boundary.
          setTimeout(async () => {
          console.log(`[P2P Connection][${connKey}] Encrypted payload successfully decrypted:`, plaintext);
          try {
            const payload = JSON.parse(plaintext);

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
              console.log(`[P2P Hub Relay] Relaying ${payload.type} packet to remote peer ${relayToId}`);
              const targetTransport = chatService.getActiveTransport(relayToId);
              if (targetTransport && targetTransport.isHandshakeComplete()) {
                try {
                  await targetTransport.send(plaintext);
                } catch (err) {
                  console.warn(`[P2P Hub Relay] Failed to relay packet to ${relayToId}:`, err);
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
                    console.warn(`[P2P Hub Relay] Failed to relay broadcast to ${pId}:`, err);
                  }
                }
              });
            }

            if (payload.type === 'chat') {
              console.log('[P2P Connection] Received chat message payload:', payload);
              await chatService.handleIncomingMessage(payload);
            } else if (payload.type === 'chat_file_start' || payload.type === 'chat_file_chunk' || payload.type === 'chat_file_end') {
              await chatService.handleIncomingFilePayload(payload);
            } else if (payload.type === 'location_share') {
              const peersRepo = new MobileRepository(db);
              await peersRepo.updatePeerLocation(payload.senderId, payload.lat, payload.lng);
              console.log(`[P2P Connection] Received location share from ${payload.senderId}: ${payload.lat}, ${payload.lng}`);
            } else if (payload.type === 'sos') {
              console.log('[P2P Connection] Received SOS event payload:', payload);
              await sosService.handleIncomingSos(payload);
            } else if (payload.type === 'ping') {
              try {
                const localUser = await new MobileRepository(db).getLocalUser();
                const myId = localUser ? (localUser._raw as any).device_id : localDeviceId;
                const pongPayload = { type: 'pong', senderId: myId, timestamp: Date.now() };
                await secure.send(JSON.stringify(pongPayload));
              } catch (err) {
                console.warn('[P2P Connection] Failed sending pong response:', err);
              }
            } else if (payload.type === 'pong') {
              // Activity already updated above
            } else if (payload.type === 'ack') {
              console.log(`[P2P Connection] Received delivery ack for message ${payload.messageId}`);
              await chatService.markMessageDelivered(payload.messageId);
            }
          } catch (err) {
            console.error('Error handling incoming secure packet payload:', err);
          }
          }, 0); // Defer to next event loop tick — keeps UI responsive
        });

        secure.onHandshakeReady(async () => {
          clearHandshakeRecovery();
          const remoteId = secure.getRemoteDeviceId();
          const remoteKey = secure.getRemotePublicKey();
          const remoteName = secure.getRemoteDisplayName();
          if (remoteId) {
            console.log(`[P2P Connection][${connKey}] Handshake completed successfully. Registering transport for remote peer: ${remoteId}`);
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
                console.log('[P2P Connection] Shared initial coordinates with remote peer.');
              }
            } catch (err) {
              console.warn('[P2P Connection] Failed sending initial location sharing packet:', err);
            }
          }
        });

        raw.onDisconnect(async () => {
          clearHandshakeRecovery();
          const remoteId = entry.deviceId ?? secure.getRemoteDeviceId();
          if (remoteId) {
            console.log(`[P2P DEBUG][${connKey}] TCP socket disconnected. Unregistering transport for: ${remoteId}`);
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
            console.log('[P2P DEBUG] All connections gone. Resetting group state and triggering P2P cleanup...');
            await performP2PCleanup('All Clients Disconnected').catch((err) =>
              console.warn('[P2P DEBUG] performP2PCleanup after full disconnect failed:', err)
            );
          } else if (groupRole === 'client') {
            // Only the client role is exclusive to one group; losing our one
            // client connection frees us up to look for (or accept) another.
            groupRole = 'unassigned';
          }

          console.log(`[P2P DEBUG][${connKey}] Disconnected. Triggering re-discovery...`);
          AndroidWifiP2PTransport.discoverPeers().catch((err) =>
            console.warn('[P2P DEBUG] Re-discovery after disconnect failed:', err)
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
          console.warn('Private key not found in SecureStore. Session corrupted, logging out.');
          await authService.logout();
          dispatch(logout());
          return;
        }

        console.log(`[P2P Bootstrap] Initializing transports for user: ${deviceId}`);

        // Reset per-session state
        connectingKeys.clear();
        groupRole = 'unassigned';
        serverSocketBound = false;
        if (discoveryRetryTimer) {
          clearInterval(discoveryRetryTimer);
          discoveryRetryTimer = null;
        }
        if (groupFormationTimeout) {
          clearTimeout(groupFormationTimeout);
          groupFormationTimeout = null;
        }

        // TDOWN: Always remove/disconnect any pre-existing native Wi-Fi Direct groups first!
        await performP2PCleanup('Bootstrap');

        // === STEP 1: Strict Sequential Permission Gate ===
        // Request ALL required permissions (BLE + Wi-Fi Direct + Location)
        // before proceeding to any hardware operation.
        const permResult = await requestP2pPermissions();
        if (!permResult.allGranted) {
          console.warn(
            `[P2P Bootstrap] Permission gate REJECTED. Missing: ${permResult.deniedSummary}. ` +
            'Cannot start advertising, scanning, or discovery without all P2P permissions.'
          );
          return;
        }
        console.log('[P2P Bootstrap] Permission gate PASSED. All P2P permissions granted.');

        // Verify location services are enabled (BLE scan requires them on Android)
        if (Platform.OS === 'android') {
          const locServicesEnabled = await Location.hasServicesEnabledAsync();
          console.log(`[P2P Bootstrap] Location Services Enabled: ${locServicesEnabled}`);
          if (!locServicesEnabled) {
            console.warn('[P2P Bootstrap] Location Services are DISABLED. Android may silently drop BLE scan results!');
          }
        }

        // === STEP 2: Initialize Hardware ===
        try {
          await initializeBleManager();
        } catch (e) {
          console.warn('[P2P Bootstrap] BleManager init failed:', e);
        }

        // Stop any old transports
        if (currentAdvertiser) await currentAdvertiser.stopAdvertising();
        await stopScanning();
        for (const entry of Array.from(connectionsByKey.values())) {
          await entry.raw.disconnect().catch(() => { });
        }
        connectionsByKey.clear();

        const displayName = (user._raw as any).display_name || 'Peer';

        // === STEP 2.5: BLE Advertising ===
        const pubKeyHash = publicKey.slice(0, 8);
        currentAdvertiser = new BleAdvertiser(deviceId, role, pubKeyHash, displayName);
        try {
          await currentAdvertiser.startAdvertising();
        } catch (err) {
          console.warn('[P2P Bootstrap] Failed to start BLE advertising (check if Bluetooth is enabled):', err);
        }

        // === STEP 3: Wire up Wi-Fi Direct and BLE Discovery ===

        // ── Wire up Wi-Fi Direct Group formation listeners ──
        const handleConnectionInfo = async (info: any) => {
          console.log('[P2P DEBUG] Connection Info Event received:', info);
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
                // loop and tag events with a connection id — that change has
                // to happen in the (currently missing from this repo) Kotlin
                // WifiDirect module.
                console.log('[P2P DEBUG] Server socket already bound. Skipping duplicate openServerSocket.');
                return;
              }
              console.log('[P2P DEBUG] I am Group Owner. Opening TCP server socket on port 8888...');
              try {
                const raw = new AndroidWifiP2PTransport(deviceId);
                const secure = new SecureTransport(raw, privateKey, publicKey, deviceId, displayName);
                const connKey = `owner-socket-${Date.now()}`;
                const ownerEntry = setupPeerConnection(connKey, raw, secure, deviceId);
                ownerEntry.scheduleHandshakeRecovery();
                // Store the MAC of the client that just connected (captured by lastTargetMacAddress
                // on the other side). On the server side we don't know the client MAC until the
                // handshake completes, so we store nothing here — that's fine; the connKey is
                // unique enough for the owner's inbound socket lifetime.
                void ownerEntry;

                raw.onConnect(async () => {
                  console.log(`[P2P DEBUG][${connKey}] TCP Server received client connection. Initiating handshake...`);
                  try {
                    await secure.establishHandshake();
                  } catch (err) {
                    console.error('[P2P DEBUG] Failed establishing handshake on client connect:', err);
                  }
                });

                await raw.openServerSocket(8888);
                serverSocketBound = true;
                console.log('[P2P DEBUG] TCP ServerSocket bound and listening on port 8888.');
              } catch (err) {
                console.error('[P2P DEBUG] openServerSocket failed:', err);
              }
            } else {
              groupRole = 'client';
              const connKey = ownerAddress || 'pending-owner';

              if (connectionsByKey.has(connKey) || connectingKeys.has(connKey)) {
                console.log(`[P2P DEBUG] Already connected/connecting to owner ${connKey}. Ignoring duplicate event.`);
                return;
              }

              // Resolve empty owner address by fetching updated connection info with backoff
              if (!ownerAddress || ownerAddress === '') {
                console.log('[P2P DEBUG] Group Owner Address is empty. Retrying updated connection info fetch...');
                for (let attempt = 1; attempt <= 5; attempt++) {
                  await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
                  try {
                    const updatedInfo = await AndroidWifiP2PTransport.getConnectionInfo();
                    console.log(`[P2P DEBUG] Attempt ${attempt} Connection Info Fetch Result:`, updatedInfo);
                    if (updatedInfo.groupOwnerAddress && updatedInfo.groupOwnerAddress !== '') {
                      ownerAddress = updatedInfo.groupOwnerAddress;
                      break;
                    }
                  } catch (err) {
                    console.warn(`[P2P DEBUG] Attempt ${attempt} to fetch connection info failed:`, err);
                  }
                }
              }

              console.log('[P2P DEBUG] I am Client. Target Group Owner IP:', ownerAddress);
              if (!ownerAddress || ownerAddress === '') {
                console.error('[P2P DEBUG] Cannot connect: Group Owner Address remains empty after retries. Resetting P2P group...');
                groupRole = 'unassigned';
                await performP2PCleanup('Client Empty GO IP');
                return;
              }

              const finalKey = ownerAddress;
              connectingKeys.add(finalKey);

              const raw = new AndroidWifiP2PTransport(deviceId);
              const secure = new SecureTransport(raw, privateKey, publicKey, deviceId, displayName);
              const clientEntry = setupPeerConnection(finalKey, raw, secure, deviceId);
              clientEntry.scheduleHandshakeRecovery();
              // Populate the MAC address for proper disconnect-key cleanup
              if (lastTargetMacAddress) {
                clientEntry.deviceAddress = lastTargetMacAddress;
              }

              // Retry with exponential backoff: 200ms, 400ms, 800ms, 1.6s, 3.2s
              let delay = 200;
              let connected = false;
              for (let attempt = 1; attempt <= 5 && !connected; attempt++) {
                try {
                  await new Promise((resolve) => setTimeout(resolve, delay));
                  console.log(`[P2P DEBUG] TCP connection attempt ${attempt}/5 to ${ownerAddress}:8888...`);
                  await raw.connectToSocket(ownerAddress, 8888);
                  connected = true;
                  console.log('[P2P DEBUG] TCP socket connected successfully!');
                  console.log('[P2P DEBUG] Client establishing secure transport handshake...');
                  await secure.establishHandshake();
                } catch (err: any) {
                  delay = Math.min(delay * 2, 3200);
                  console.warn(`[P2P DEBUG] Attempt ${attempt}/5 failed: ${err.message || err}. Next retry in ${delay / 1000}s.`);
                  if (attempt === 5) {
                    console.error('[P2P DEBUG] Max connection retries reached. Group Owner unreachable. Resetting P2P group...');
                    connectingKeys.delete(finalKey);
                    connectionsByKey.delete(finalKey);
                    // Immediately trigger re-discovery instead of waiting for periodic timer
                    groupRole = 'unassigned';
                    await performP2PCleanup('Client Retry Max Failure');
                    AndroidWifiP2PTransport.discoverPeers().catch((e) =>
                      console.warn('[P2P DEBUG] Re-discovery after max retries failed:', e)
                    );
                  }
                }
              }
            }
          } else {
            console.log('[P2P DEBUG] Group is not formed (info.groupFormed is false). Waiting for connection to establish...');
            // We do NOT reset connection flags here, because during the CONNECTING phase, groupFormed is false.
            // Resetting here would immediately abort any pending connection attempts.
            serverSocketBound = false;
          }
        };

        unsubConnectionInfo = AndroidWifiP2PTransport.onConnectionInfo(handleConnectionInfo);

        unsubPeersChanged = AndroidWifiP2PTransport.onPeersChanged(async (peers) => {
          console.log('[P2P DEBUG] Wi-Fi Direct peers changed. Peers count:', peers.length, 'Peers:', peers);
          console.log('[P2P DEBUG] Wi-Fi Direct peers changed. Peers count:', peers.length, 'Peers:', peers);

          // A device already committed as a CLIENT of another group cannot
          // also connect out to a second peer â€” that's a real Wi-Fi Direct
          // constraint. But being the GROUP OWNER (or unassigned) should NOT
          // stop us from inviting additional available peers in.
          if (groupRole === 'client') {
            console.log('[P2P DEBUG] Already a client of another group. Ignoring peers list.');
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
            console.log('[P2P DEBUG] No new AVAILABLE peers to connect to.');
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
              console.log(`[P2P DEBUG] Candidate '${wifiName}' resolved via BLE map => ${bleRemoteId.substring(0, 8)}. isInitiator=${isInitiator}`);
              if (isInitiator) {
                candidateToConnect = c;
                break;
              }
              continue;
            } else if (bleMatches.length > 1) {
              console.log(`[P2P DEBUG] Candidate '${wifiName}' has ${bleMatches.length} BLE matches (name collision). Falling to name fallback.`);
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
            console.log(`[P2P DEBUG] Candidate '${wifiName}' name fallback: local='${localFirstWord}' remote='${firstWordKey}' isInitiator=${isInitiatorFallback}`);
            if (isInitiatorFallback) {
              candidateToConnect = c;
              break;
            }
          }

          if (!candidateToConnect) {
            console.log('[P2P DEBUG] We are not the initiator for any available candidate peer. Waiting for them to connect...');
            return;
          }

          connectingKeys.add(candidateToConnect.deviceAddress);
          // Remember the MAC so setupPeerConnection can populate entry.deviceAddress
          lastTargetMacAddress = candidateToConnect.deviceAddress;
          console.log('[P2P DEBUG] Selected target peer for Wi-Fi Direct connection:', candidateToConnect.deviceName, candidateToConnect.deviceAddress);
          try {
            await AndroidWifiP2PTransport.connectToPeer(candidateToConnect.deviceAddress);
            console.log('[P2P DEBUG] Native connectToPeer call resolved successfully. Waiting for Group Formation connection info event...');

            // Active polling fallback: check group status periodically to handle lost/delayed OS broadcasts
            let pollCount = 0;
            const intervalId = setInterval(async () => {
              pollCount++;
              if (pollCount > 15) {
                clearInterval(intervalId);
                console.warn('[P2P DEBUG] Active poll timed out after 15 seconds. Group still not formed.');
                if (groupRole === 'unassigned') {
                  connectingKeys.delete(candidateToConnect.deviceAddress);
                  await performP2PCleanup('Initiator Poll Timeout');
                }
                return;
              }
              try {
                const info = await AndroidWifiP2PTransport.getConnectionInfo();
                if (info.groupFormed) {
                  clearInterval(intervalId);
                  if (groupRole === 'unassigned') {
                    console.log(`[P2P DEBUG] Group formation detected via active poll (attempt ${pollCount}). Setting up socket...`);
                    await handleConnectionInfo(info);
                  }
                }
              } catch (e) {
                console.warn('[P2P DEBUG] Connection info poll failed:', e);
              }
            }, 1000);
          } catch (err: any) {
            console.error('[P2P DEBUG] connectToPeer failed:', err);
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

        console.log('[P2P Bootstrap] STEP 3 INIT: Wi-Fi Direct listeners registered. Triggering initial discoverPeers...');
        AndroidWifiP2PTransport.discoverPeers().catch((err) =>
          console.warn('[P2P Bootstrap] Initial discoverPeers failed:', err)
        );

        let lastDiscoverTime = 0;
        const scannedPeersCache = new Set<string>();

        // Wire up BLE discovery callback
        const handlePeerDiscovered = async (peerDevice: any) => {
          // Feed to PeerRegistry
          PeerRegistry.upsert({
            id: peerDevice.device_id,
            ...peerDevice,
            discovered_at: Date.now(),
            last_seen: Date.now(),
          });

          if (!scannedPeersCache.has(peerDevice.device_id)) {
            scannedPeersCache.add(peerDevice.device_id);
            try {
              const peersRepo = new MobileRepository(db);
              const exists = await peersRepo.getPeer(peerDevice.device_id);
              if (!exists) {
                console.log(`[P2P DEBUG] First time seeing peer ${peerDevice.device_id.substring(0, 8)} via BLE. Adding to local DB...`);
                await peersRepo.addNewPeer({
                  deviceId: peerDevice.device_id,
                  publicKey: peerDevice.public_key_hash,
                  role: peerDevice.role,
                  trustStatus: 'pending',
                  displayName: peerDevice.name
                });
              } else if (!(exists._raw as any).display_name && peerDevice.name) {
                await peersRepo.addNewPeer({
                  deviceId: peerDevice.device_id,
                  publicKey: peerDevice.public_key_hash,
                  role: peerDevice.role,
                  trustStatus: (exists._raw as any).trust_status,
                  displayName: peerDevice.name
                });
              }
            } catch (err) {
              console.warn('[P2P DEBUG] Failed to query/add new BLE peer to DB:', err);
              scannedPeersCache.delete(peerDevice.device_id);
            }
          }

          if (peerDevice.rssi) {
            mapService.updatePeerRssi(peerDevice.device_id, peerDevice.rssi);
          }

          // ── Update live BLE-first resolution map ─────────────────────────────
          if (peerDevice.name) {
            const firstWord = peerDevice.name.split(/['\s]/)[0].toLowerCase();
            const idPrefix = peerDevice.device_id.substring(0, 8).toLowerCase();
            const compoundKey = `${firstWord}:${idPrefix}`;
            bleDiscoveredIds.set(compoundKey, peerDevice.device_id);
            console.log(`[P2P DEBUG] BLE map updated: '${compoundKey}' => ${peerDevice.device_id.substring(0, 8)}`);
          }

          const alreadyConnected = connectionsByKey.has(peerDevice.device_id) ||
            Array.from(connectionsByKey.values()).some((c) => c.deviceId === peerDevice.device_id);

          if (groupRole !== 'client' && !alreadyConnected) {
            console.log(`[P2P DEBUG] BLE Scanned Peer: ${peerDevice.device_id.substring(0, 8)}. My ID: ${deviceId.substring(0, 8)}.`);

            const now = Date.now();
            if (now - lastDiscoverTime > 5000) {
              lastDiscoverTime = now;
              console.log('[P2P DEBUG] Triggering native Wi-Fi Direct peer discovery (throttled)...');
              try {
                await AndroidWifiP2PTransport.discoverPeers();
              } catch (err) {
                console.warn('[P2P DEBUG] discoverPeers failed:', err);
              }
            }
          }
        };

        // â”€â”€ Periodic discovery retry timer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // If onPeersChanged never fires (devices not in same discovery window),
        // re-trigger discoverPeers every 10s while we're unassigned and have
        // at least one BLE-discovered peer we haven't connected to yet.
        if (discoveryRetryTimer) clearInterval(discoveryRetryTimer);
        discoveryRetryTimer = setInterval(async () => {
          if (groupRole !== 'unassigned' || bleDiscoveredIds.size === 0) return;
          const hasUnconnectedBlePeer = Array.from(bleDiscoveredIds.values()).some(
            (id) => !Array.from(connectionsByKey.values()).some((conn) => conn.deviceId === id)
          );
          if (!hasUnconnectedBlePeer) return;
          console.log('[P2P DEBUG] Retry timer: still unassigned with known BLE peers. Re-triggering discoverPeers...');
          try {
            await AndroidWifiP2PTransport.discoverPeers();
          } catch (err) {
            console.warn('[P2P DEBUG] Retry discoverPeers failed:', err);
          }
        }, 10000);

        try {
          await startScanning(handlePeerDiscovered);
        } catch (err) {
          console.warn('[P2P Bootstrap] Failed to start BLE scanning (check if Bluetooth is enabled):', err);
        }

        // Safety timeout: if groupRole is still 'unassigned' after 60 seconds,
        // trigger a re-discovery cycle
        groupFormationTimeout = setTimeout(async () => {
          if (groupRole === 'unassigned' && connectionsByKey.size === 0) {
            console.log('[P2P Bootstrap] Group formation timeout (60s). Re-triggering discovery...');
            try {
              await AndroidWifiP2PTransport.discoverPeers();
            } catch (err) {
              console.warn('[P2P Bootstrap] Re-discovery after timeout failed:', err);
            }
          }
        }, 60000);
      };

      /**
       * Shuts down all active BLE advertisements, scanners, and socket streams.
       */
      const shutdownTransports = async () => {
        console.log('[P2P Bootstrap] Shutting down transport protocols.');
        if (discoveryRetryTimer) {
          clearInterval(discoveryRetryTimer);
          discoveryRetryTimer = null;
        }
        if (groupFormationTimeout) {
          clearTimeout(groupFormationTimeout);
          groupFormationTimeout = null;
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
        await cleanupBleScanner();
        for (const entry of Array.from(connectionsByKey.values())) {
          await entry.raw.disconnect().catch(() => { });
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
      console.error('Failed to bootstrap services:', error);
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
      console.log('[P2P Bootstrap] AppState transition to:', nextState, '(Transports kept active)');
    };

    const appStateSub = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      clearInterval(servicesUpdateUnsub);
      appStateSub.remove();
      // Tear down all BLE and Wi-Fi Direct resources on unmount
      if (cleanupTransports) {
        cleanupTransports().catch((err) =>
          console.warn('[P2P Bootstrap] Cleanup on unmount failed:', err)
        );
      }
    };
  }, []);

  return services;
}

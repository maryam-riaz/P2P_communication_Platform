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

export interface Services {
  authService: AuthService;
  chatService: ChatService;
  mapService: MapService;
  sosService: SosService;
  database: Database;
  bleScanner?: BleScanner;
  bleAdvertiser?: BleAdvertiser;
  rawTransport?: AndroidWifiP2PTransport;
  secureTransport?: SecureTransport;
  initTransportsForUser: (user: LocalUser) => Promise<void>;
  shutdownTransports: () => Promise<void>;
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
          useIncrementalIndexedDB: false,
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
      let currentScanner: BleScanner | undefined;
      let currentRawTransport: AndroidWifiP2PTransport | undefined;
      let currentSecureTransport: SecureTransport | undefined;
      let unsubConnectionInfo: (() => void) | null = null;
      let unsubPeersChanged: (() => void) | null = null;
      // Guard flags to prevent duplicate socket open and duplicate peer connect calls
      let serverSocketBound = false;
      let isPeerConnecting = false;

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

        // Reset per-session state flags
        serverSocketBound = false;
        isPeerConnecting = false;
        let isInitiatorForAny = false;

        // TDOWN: Always remove/disconnect any pre-existing native Wi-Fi Direct groups first!
        try {
          console.log('[P2P Bootstrap] Tearing down stale Wi-Fi Direct groups...');
          await AndroidWifiP2PTransport.removeGroup();
        } catch (err) {
          console.warn('[P2P Bootstrap] removeGroup failed (normal if no active group):', err);
        }

        // Request Bluetooth permissions before starting advertising/scanning
        const permissionsGranted = await requestBlePermissions();
        if (!permissionsGranted) {
          console.warn('[P2P Bootstrap] Bluetooth permissions not granted. Cannot start advertising or scanning.');
          return;
        }

        // Stop any old transports
        if (currentAdvertiser) await currentAdvertiser.stopAdvertising();
        if (currentScanner) currentScanner.stopScanning();
        if (currentRawTransport) await currentRawTransport.disconnect();

        // Instantiate Phase 2 BLE scanning & advertising
        const pubKeyHash = publicKey.slice(0, 8); // 4-byte hash (8 hex chars)
        currentAdvertiser = new BleAdvertiser(deviceId, role, pubKeyHash);
        try {
          await currentAdvertiser.startAdvertising();
        } catch (err) {
          console.warn('[P2P Bootstrap] Failed to start BLE advertising (check if Bluetooth is enabled):', err);
        }

        // Instantiate Phase 2 Android Wifi Direct
        currentRawTransport = new AndroidWifiP2PTransport(deviceId);

        // Instantiate Phase 3 Cryptographic secure channel
        const displayName = (user._raw as any).display_name || 'Peer';
        currentSecureTransport = new SecureTransport(currentRawTransport, privateKey, publicKey, deviceId, displayName);

        // ── CRITICAL: Register SecureTransport callbacks BEFORE any TCP socket opens ──
        // This prevents the BUG 4 race where PUBKEY_EXCHANGE arrives before listeners are ready.

        // Wire up SecureTransport receive callback (registered before TCP opens)
        currentSecureTransport.receive(async (plaintext) => {
          console.log('[P2P Connection] Encrypted payload successfully decrypted:', plaintext);
          try {
            const payload = JSON.parse(plaintext);

            // Mark connection activity as alive for any received packet
            const remoteId = currentSecureTransport?.getRemoteDeviceId();
            if (remoteId) {
              chatService.updateTransportActivity(remoteId);
            }

            if (payload.type === 'chat') {
              console.log('[P2P Connection] Received chat message payload:', payload);
              await chatService.handleIncomingMessage(payload);
            } else if (payload.type === 'location_share') {
              const peersRepo = new MobileRepository(db);
              await peersRepo.updatePeerLocation(payload.senderId, payload.lat, payload.lng);
              console.log(`[P2P Connection] Received location share from ${payload.senderId}: ${payload.lat}, ${payload.lng}`);
            } else if (payload.type === 'sos') {
              console.log('[P2P Connection] Received SOS event payload:', payload);
              await sosService.handleIncomingSos(payload);
            } else if (payload.type === 'ping') {
              // BUG 9 FIX: Resolve deviceId dynamically rather than relying on closure
              try {
                const localUser = await new MobileRepository(db).getLocalUser();
                const myId = localUser ? (localUser._raw as any).device_id : deviceId;
                const pongPayload = { type: 'pong', senderId: myId, timestamp: Date.now() };
                await currentSecureTransport?.send(JSON.stringify(pongPayload));
              } catch (err) {
                console.warn('[P2P Connection] Failed sending pong response:', err);
              }
            } else if (payload.type === 'pong') {
              // Activity already updated above
            }
          } catch (err) {
            console.error('Error handling incoming secure packet payload:', err);
          }
        });

        // Handshake completion handler (registered before TCP opens)
        currentSecureTransport.onHandshakeReady(async () => {
          const remoteId = currentSecureTransport?.getRemoteDeviceId();
          const remoteKey = currentSecureTransport?.getRemotePublicKey();
          const remoteName = currentSecureTransport?.getRemoteDisplayName();
          if (remoteId && currentSecureTransport) {
            console.log(`[P2P Connection] Handshake completed successfully. Registering transport for remote peer: ${remoteId}`);
            chatService.registerActiveTransport(remoteId, currentSecureTransport);
            // Connection is fully established — allow future reconnect cycles
            isPeerConnecting = false;

            // Save remote user's display name and public key in known_peers
            const peersRepo = new MobileRepository(db);
            await peersRepo.addNewPeer({
              deviceId: remoteId,
              publicKey: remoteKey || '',
              role: 'user',
              trustStatus: 'trusted',
              displayName: remoteName || undefined
            });

            // Immediately send current location to newly paired peer if available
            try {
              const latestLoc = await db.get<LocationLog>('location_log')
                .query(
                  Q.where('device_id', deviceId),
                  Q.sortBy('timestamp', Q.desc),
                  Q.take(1)
                ).fetch();

              if (latestLoc.length > 0) {
                const loc = latestLoc[0]._raw as any;
                const payload = {
                  type: 'location_share',
                  senderId: deviceId,
                  lat: loc.lat,
                  lng: loc.lng,
                  timestamp: Date.now()
                };
                await currentSecureTransport.send(JSON.stringify(payload));
                console.log('[P2P Connection] Shared initial coordinates with remote peer.');
              }
            } catch (err) {
              console.warn('[P2P Connection] Failed sending initial location sharing packet:', err);
            }
          }
        });

        // ── Wire up Wi-Fi Direct Group formation listeners ──
        unsubConnectionInfo = AndroidWifiP2PTransport.onConnectionInfo(async (info) => {
          console.log('[P2P DEBUG] Connection Info Event received:', info);
          if (info.groupFormed && currentRawTransport) {
            let ownerAddress = info.groupOwnerAddress;
            let isOwner = info.isGroupOwner;

            if (isOwner) {
              if (serverSocketBound) {
                console.log('[P2P DEBUG] Server socket already bound. Skipping duplicate openServerSocket.');
                return;
              }
              console.log('[P2P DEBUG] I am Group Owner. Opening TCP server socket on port 8888...');
              try {
                await currentRawTransport.openServerSocket(8888);
                serverSocketBound = true;
                console.log('[P2P DEBUG] TCP ServerSocket bound and listening on port 8888.');
              } catch (err) {
                console.error('[P2P DEBUG] openServerSocket failed:', err);
              }
            } else {
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
                isPeerConnecting = false;
                try {
                  await AndroidWifiP2PTransport.removeGroup();
                } catch (cleanErr) {
                  console.warn('[P2P DEBUG] removeGroup failed:', cleanErr);
                }
                return;
              }

              // Retry with exponential backoff: 2s, 4s, 8s, 16s, 32s
              let delay = 2000;
              let connected = false;
              for (let attempt = 1; attempt <= 5 && !connected; attempt++) {
                try {
                  await new Promise((resolve) => setTimeout(resolve, delay));
                  console.log(`[P2P DEBUG] TCP connection attempt ${attempt}/5 to ${ownerAddress}:8888...`);
                  await currentRawTransport.connectToSocket(ownerAddress, 8888);
                  connected = true;
                  console.log('[P2P DEBUG] TCP socket connected successfully!');
                  if (currentSecureTransport) {
                    console.log('[P2P DEBUG] Client establishing secure transport handshake...');
                    await currentSecureTransport.establishHandshake();
                  }
                } catch (err: any) {
                  delay = Math.min(delay * 2, 32000);
                  console.warn(`[P2P DEBUG] Attempt ${attempt}/5 failed: ${err.message || err}. Next retry in ${delay / 1000}s.`);
                  if (attempt === 5) {
                    console.error('[P2P DEBUG] Max connection retries reached. Group Owner unreachable. Resetting P2P group...');
                    isPeerConnecting = false;
                    try {
                      await AndroidWifiP2PTransport.removeGroup();
                    } catch (cleanErr) {
                      console.warn('[P2P DEBUG] removeGroup failed:', cleanErr);
                    }
                  }
                }
              }
            }
          } else {
            console.log('[P2P DEBUG] Group is not formed (info.groupFormed is false). Resetting connection flags.');
            serverSocketBound = false;
            isPeerConnecting = false;
          }
        });

        unsubPeersChanged = AndroidWifiP2PTransport.onPeersChanged(async (peers) => {
          console.log('[P2P DEBUG] Wi-Fi Direct peers changed. Peers count:', peers.length, 'Peers:', peers);
          if (!currentRawTransport || currentRawTransport.isConnected() || isPeerConnecting) {
            console.log('[P2P DEBUG] Connection in progress, already connected, or raw transport not ready. Ignoring peers list.');
            return;
          }

          if (!isInitiatorForAny) {
            console.log('[P2P DEBUG] I am not the initiator. Ignoring peers list and waiting for incoming connection.');
            return;
          }

          // Find an available peer (status 3 = AVAILABLE)
          const peer = peers.find((p) => p.status === 3);
          if (!peer) {
            console.log('[P2P DEBUG] No peers in the list are currently in AVAILABLE status.');
            return;
          }
          isPeerConnecting = true;
          console.log('[P2P DEBUG] Selected target peer for Wi-Fi Direct connection:', peer.deviceName, peer.deviceAddress);
          try {
            await AndroidWifiP2PTransport.connectToPeer(peer.deviceAddress);
            console.log('[P2P DEBUG] Native connectToPeer call resolved successfully. Waiting for Group Formation connection info event...');
          } catch (err: any) {
            console.error('[P2P DEBUG] connectToPeer failed:', err);
            await new Promise((resolve) => setTimeout(resolve, 3000));
            try {
              await AndroidWifiP2PTransport.removeGroup();
              console.log('[P2P DEBUG] Cleaned up stale group after connection failure.');
            } catch (cleanErr) {
              console.warn('[P2P DEBUG] removeGroup clean failed:', cleanErr);
            }
            isPeerConnecting = false;
          }
        });

        // Server-side: initiate handshake when a client connects to the TCP ServerSocket
        currentRawTransport.onConnect(async () => {
          console.log('[P2P DEBUG] TCP Server received client connection. Initiating handshake...');
          if (currentSecureTransport) {
            try {
              await currentSecureTransport.establishHandshake();
            } catch (err) {
              console.error('[P2P DEBUG] Failed establishing handshake on client connect:', err);
            }
          }
        });

        // On disconnect: unregister transport AND trigger re-discovery (BUG 7 FIX)
        currentRawTransport.onDisconnect(() => {
          const remoteId = currentSecureTransport?.getRemoteDeviceId();
          if (remoteId) {
            console.log(`[P2P DEBUG] TCP socket disconnected. Unregistering transport for: ${remoteId}`);
            chatService.unregisterActiveTransport(remoteId);
          }
          serverSocketBound = false;
          isPeerConnecting = false;
          isInitiatorForAny = false;
          console.log('[P2P DEBUG] Disconnected. Triggering re-discovery...');
          AndroidWifiP2PTransport.discoverPeers().catch((err) =>
            console.warn('[P2P DEBUG] Re-discovery after disconnect failed:', err)
          );
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
                console.log(`[P2P DEBUG] First time seeing peer ${peerDevice.deviceId.substring(0, 8)} via BLE. Adding to local DB...`);
                await peersRepo.addNewPeer({
                  deviceId: peerDevice.deviceId,
                  publicKey: peerDevice.publicKeyHash,
                  role: peerDevice.role,
                  trustStatus: 'pending'
                });
              }
            } catch (err) {
              console.warn('[P2P DEBUG] Failed to query/add new BLE peer to DB:', err);
              scannedPeersCache.delete(peerDevice.deviceId);
            }
          }

          mapService.updatePeerRssi(peerDevice.deviceId, peerDevice.rssi);

          if (currentRawTransport && !currentRawTransport.isConnected()) {
            const isInitiator = deviceId < peerDevice.deviceId;
            console.log(`[P2P DEBUG] BLE Scanned Peer: ${peerDevice.deviceId.substring(0, 8)}. My ID: ${deviceId.substring(0, 8)}. isInitiator = ${isInitiator}`);
            if (isInitiator) {
              isInitiatorForAny = true;
            }

            const now = Date.now();
            if (now - lastDiscoverTime > 15000) {
              lastDiscoverTime = now;
              console.log('[P2P DEBUG] Triggering native Wi-Fi Direct peer discovery (throttled)...');
              try {
                await AndroidWifiP2PTransport.discoverPeers();
              } catch (err) {
                console.warn('[P2P DEBUG] discoverPeers failed:', err);
              }
            }
          }
        });

        try {
          currentScanner.startScanning();
        } catch (err) {
          console.warn('[P2P Bootstrap] Failed to start BLE scanning (check if Bluetooth is enabled):', err);
        }
      };

      /**
       * Shuts down all active BLE advertisements, scanners, and socket streams.
       */
      const shutdownTransports = async () => {
        console.log('[P2P Bootstrap] Shutting down transport protocols.');
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
        if (currentRawTransport) {
          await currentRawTransport.disconnect();
          currentRawTransport = undefined;
        }
        currentSecureTransport = undefined;
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

import { useEffect, useState } from 'react';
import { Database } from '@nozbe/watermelondb';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';

import { Platform } from 'react-native';
import { secureStore as SecureStore } from '../utils/secureStore';

import { localDbSchema } from '../db/schema';
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

      // Context state holders for dynamic P2P setup
      let currentAdvertiser: BleAdvertiser | undefined;
      let currentScanner: BleScanner | undefined;
      let currentRawTransport: AndroidWifiP2PTransport | undefined;
      let currentSecureTransport: SecureTransport | undefined;

      /**
       * Dynamic initialization of BLE and Wi-Fi Direct transports once identity is loaded.
       */
      const initTransportsForUser = async (user: LocalUser) => {
        const deviceId = user._raw.device_id as string;
        const role = user._raw.role as any;
        const publicKey = user._raw.public_key as string;
        const privateKey = await SecureStore.getItemAsync(`private_key_${deviceId}`);

        if (!privateKey) {
          console.warn('Private key not found in SecureStore. Deferred transport boot.');
          return;
        }

        console.log(`[P2P Bootstrap] Initializing transports for user: ${deviceId}`);

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
        currentSecureTransport = new SecureTransport(currentRawTransport, privateKey, publicKey);

        // Register active transport session inside ChatService for outbound queues
        chatService.registerActiveTransport(deviceId, currentSecureTransport);

        // Wire up BLE discovery callback
        currentScanner = new BleScanner(async (peerDevice) => {
          const peersRepo = new MobileRepository(db);
          
          // Write discovered peer metadata into known_peers
          await peersRepo.addNewPeer({
            deviceId: peerDevice.deviceId,
            publicKey: peerDevice.publicKeyHash, // Map public key hash as stub placeholder
            role: peerDevice.role,
            trustStatus: 'pending'
          });

          // Connect transport if not connected
          if (currentRawTransport && !currentRawTransport.isConnected()) {
            try {
              // Trigger TCP Socket connection (loopback simulated port or peer IP)
              await currentRawTransport.connectToSocket('127.0.0.1', 8888);
              await currentSecureTransport?.establishHandshake();
            } catch (err) {
              console.warn(`Failed socket link to remote peer ${peerDevice.deviceId}`, err);
            }
          }
        });
        try {
          currentScanner.startScanning();
        } catch (err) {
          console.warn('[P2P Bootstrap] Failed to start BLE scanning (check if Bluetooth is enabled):', err);
        }

        // Wire up SecureTransport receive callback
        currentSecureTransport.receive(async (plaintext) => {
          try {
            const payload = JSON.parse(plaintext);
            if (payload.type === 'chat') {
              await chatService.handleIncomingMessage(payload);
            } else if (payload.type === 'sos') {
              await sosService.handleIncomingSos(payload);
            }
          } catch (err) {
            console.error('Error handling incoming secure packet payload:', err);
          }
        });
      };

      /**
       * Shuts down all active BLE advertisements, scanners, and socket streams.
       */
      const shutdownTransports = async () => {
        console.log('[P2P Bootstrap] Shutting down transport protocols.');
        if (currentAdvertiser) {
          await currentAdvertiser.stopAdvertising();
          currentAdvertiser = undefined;
        }
        if (currentScanner) {
          currentScanner.stopScanning();
          currentScanner = undefined;
        }
        if (currentRawTransport) {
          await currentRawTransport.disconnect();
          currentRawTransport = undefined;
        }
        currentSecureTransport = undefined;
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

    initAsync().catch((error) => {
      console.error('Failed to bootstrap services:', error);
    });

    return () => {
      // Cleanup adapters on unmount
    };
  }, []);

  return services;
}

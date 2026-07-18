/**
 * BLE Scanner with NativeEventEmitter
 * 
 * Replaces polling with event-driven discovery.
 * Manages duty cycle: scan 2s, sleep 3s (~40% active).
 * Parses 25-byte manufacturer data packets without connecting to peripherals.
 */

import { NativeEventEmitter, NativeModules, EventSubscription } from 'react-native';
import type { BLEAdvertisementData, DiscoveredPeer } from './ble-types';
import { logger } from '../../utils/Logger';

import BleManager from 'react-native-ble-manager';

const emitter = new NativeEventEmitter(NativeModules.BleManager);

// App-specific BLE configuration
const DISASTER_P2P_SERVICE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const DISASTER_P2P_MANUFACTURER_ID = 0x004c; // Apple's manufacturer ID for testing; use your own
const SCAN_DURATION_MS = 2000;   // Scan for 2 seconds
const SLEEP_DURATION_MS = 3000;  // Sleep for 3 seconds
const AD_PACKET_SIZE = 25;       // Expected payload size

let isScanning = false;
let scanTimer: NodeJS.Timeout | null = null;
let peripheralListener: EventSubscription | null = null;
let stateListener: EventSubscription | null = null;

/**
 * Parse the 25-byte manufacturer data packet.
 * Expected format (from TRANSPORT.md):
 * - device_id (16 bytes) — hardware UUID
 * - role (1 byte) — 0=Victim, 1=Rescuer, 2=Admin
 * - public_key_hash (4 bytes) — first 4 bytes of SHA-256(pubkey)
 * - timestamp (4 bytes) — Unix seconds (big-endian)
 */
function parseAdvertisementPacket(data: string | Uint8Array | number[]): BLEAdvertisementData | null {
  try {
    let bytes: Uint8Array;
    if (typeof data === 'string') {
      if (data.length === AD_PACKET_SIZE * 2) {
        bytes = new Uint8Array(data.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
      } else {
        bytes = new Uint8Array(Buffer.from(data, 'base64'));
      }
    } else if (Array.isArray(data)) {
      bytes = new Uint8Array(data);
    } else {
      bytes = new Uint8Array(data);
    }

    if (bytes.length !== AD_PACKET_SIZE) {
      logger.warn('BLE', `Invalid ad packet size: ${bytes.length}, expected ${AD_PACKET_SIZE}`);
      return null;
    }

    const device_id = Buffer.from(bytes.slice(0, 16)).toString('hex');
    const role = bytes[16];
    const public_key_hash = Buffer.from(bytes.slice(17, 21)).toString('hex');
    const timestamp = new DataView(bytes.buffer, 21, 4).getUint32(0, false);

    const roles = ['victim', 'rescuer', 'admin'];
    return {
      device_id,
      role: (roles[role] as any) || 'unknown',
      public_key_hash,
      timestamp,
      rssi: undefined,
    };
  } catch (error) {
    logger.error('BLE', 'Error parsing advertisement packet', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Callback when a peripheral is discovered.
 * Extract manufacturer data without connecting.
 */
function onDiscoverPeripheral(peripheral: any): void {
  try {
    const advertising = peripheral.advertising;
    if (!advertising) return;

    // Optional fast filter if we use serviceUUIDs: []
    const hasCorrectService = advertising.serviceUUIDs?.includes(DISASTER_P2P_SERVICE_UUID) || 
                              advertising.serviceUUIDs?.includes(DISASTER_P2P_SERVICE_UUID.toLowerCase()) ||
                              advertising.serviceUUIDs?.includes(DISASTER_P2P_SERVICE_UUID.toUpperCase());

    // Extract manufacturer data (handles react-native-ble-manager object format)
    let payloadBytes: number[] | undefined;
    
    if (advertising.manufacturerRawData?.bytes) {
      payloadBytes = advertising.manufacturerRawData.bytes;
    } else if (advertising.manufacturerData) {
      const keys = Object.keys(advertising.manufacturerData);
      if (keys.length > 0 && advertising.manufacturerData[keys[0]]?.bytes) {
        payloadBytes = advertising.manufacturerData[keys[0]].bytes;
      } else if (Array.isArray(advertising.manufacturerData)) {
        payloadBytes = advertising.manufacturerData;
      }
    }

    if (!payloadBytes) {
      // Not our packet, silently ignore to avoid log spam if we are scanning all
      return;
    }

    // Parse the 25-byte payload
    const parsed = parseAdvertisementPacket(payloadBytes);
    if (!parsed) {
      logger.warn('BLE', `Failed to parse payload from ${peripheral.id}`);
      return;
    }

    // Add RSSI and name for logging
    const adData: BLEAdvertisementData = {
      ...parsed,
      rssi: peripheral.rssi || 0,
      name: peripheral.advertising?.localName,
    };

    logger.info('BLE', `Peer: ${adData.device_id.slice(0, 8)} role=${adData.role} rssi=${adData.rssi}`);

    // Emit event for PeerRegistry to consume
    handleAdvertisementReceived(adData);
  } catch (error) {
    logger.error('BLE', 'onDiscoverPeripheral failed', error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Callback when BLE state changes.
 */
function onBleStateChange(state: string): void {
  console.log('[BLE] State changed:', state);
  if (state === 'off') {
    console.warn('[BLE] Bluetooth turned off');
    stopScanning();
  } else if (state === 'on') {
    console.log('[BLE] Bluetooth turned on');
  }
}

/**
 * Handle received advertisement (to be implemented by the app).
 * This will be called from onDiscoverPeripheral and should be
 * connected to PeerRegistry.upsert().
 */
let advertisementHandler: ((data: BLEAdvertisementData) => void) | null = null;

function handleAdvertisementReceived(data: BLEAdvertisementData): void {
  if (advertisementHandler) {
    advertisementHandler(data);
  }
}

/**
 * Start the duty-cycled BLE scan.
 * Scan 2s, sleep 3s, repeat.
 */
export async function startScanning(
  onAdvertisement: (data: BLEAdvertisementData) => void
): Promise<void> {
  if (isScanning) {
    logger.warn('BLE', 'Scan already in progress');
    return;
  }

  advertisementHandler = onAdvertisement;

  try {
    // Subscribe to peripheral discovery events
    if (peripheralListener) {
      peripheralListener.remove();
    }
    peripheralListener = emitter.addListener('BleManagerDiscoverPeripheral', onDiscoverPeripheral);

    // Subscribe to BLE state change events
    if (stateListener) {
      stateListener.remove();
    }
    stateListener = emitter.addListener('BleManagerDidUpdateState', onBleStateChange);

    isScanning = true;
    logger.info('BLE', 'Starting duty-cycled scan (2s on, 3s off)');

    // Start the first scan cycle
    await executeScanCycle();
  } catch (error) {
    logger.error('BLE', 'startScanning failed', error instanceof Error ? error : new Error(String(error)));
    isScanning = false;
    throw error;
  }
}

/**
 * Execute one scan cycle and schedule the next.
 */
async function executeScanCycle(): Promise<void> {
  if (!isScanning) return;

  try {
    // Scan for SCAN_DURATION_MS seconds
    logger.debug('BLE', 'Starting scan cycle (2s)');
    await BleManager.scan({
      serviceUUIDs: [], // Scan all devices to bypass strict OS filtering bugs, we filter in JS
      seconds: Math.ceil(SCAN_DURATION_MS / 1000),
      allowDuplicates: true, // We want continuous updates
      matchMode: 2, // MATCH_MODE_AGGRESSIVE
      scanMode: 1,  // SCAN_MODE_LOW_LATENCY
    });

    // Schedule the sleep and next cycle
    scanTimer = setTimeout(async () => {
      logger.debug('BLE', 'Scan cycle complete, sleeping for 3s');
      // After sleep, execute next cycle
      await executeScanCycle();
    }, SLEEP_DURATION_MS);
  } catch (error) {
    logger.error('BLE', 'Error during scan cycle', error instanceof Error ? error : new Error(String(error)));
    if (isScanning) {
      // Retry after a delay
      scanTimer = setTimeout(executeScanCycle, 1000);
    }
  }
}

/**
 * Stop scanning and clean up listeners.
 */
export async function stopScanning(): Promise<void> {
  if (!isScanning) {
    logger.debug('BLE', 'Scan already stopped');
    return;
  }

  try {
    isScanning = false;

    // Clear timers
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }

    // Stop any active scan
    await BleManager.stopScan();

    // Remove listeners to prevent memory leaks
    if (peripheralListener) {
      peripheralListener.remove();
      peripheralListener = null;
    }
    if (stateListener) {
      stateListener.remove();
      stateListener = null;
    }

    advertisementHandler = null;

    logger.info('BLE', 'Scanning stopped');
  } catch (error) {
    logger.error('BLE', 'stopScanning failed', error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Check if scanning is currently active.
 */
export function isScanningActive(): boolean {
  return isScanning;
}

/**
 * Cleanup function for app teardown.
 */
export async function cleanupBleScanner(): Promise<void> {
  await stopScanning();
}
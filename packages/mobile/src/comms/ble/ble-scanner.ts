/**
 * BLE Scanner with NativeEventEmitter
 * 
 * Replaces polling with event-driven discovery.
 * Manages duty cycle: scan 2s, sleep 3s (~40% active).
 * Parses manufacturer data packets with magic-prefix validation
 * instead of relying on a 128-bit Service UUID (which was removed
 * from the advertising packet to stay within BLE legacy limits).
 */

import { EventSubscription } from 'react-native';
import type { BLEAdvertisementData } from './ble-types';
import {
  DISASTER_P2P_MAGIC,
  DISASTER_P2P_MANUFACTURER_ID,
  AD_PAYLOAD_SIZE_FULL,
  AD_PAYLOAD_SIZE_TRIMMED,
  BLE_ROLE_BYTE_MAP,
} from './ble-types';
import { logger } from '../../utils/Logger';

import BleManager from 'react-native-ble-manager';

let isScanning = false;
let scanTimer: NodeJS.Timeout | null = null;
let peripheralListener: EventSubscription | null = null;
let stateListener: EventSubscription | null = null;
let stopListener: EventSubscription | null = null;
const lastProcessedAtMs = new Map<string, number>();

/**
 * Parse a FULL 23-byte manufacturer data packet (from BLE 5.0 extended advertising).
 *
 * Format: [magic:2][device_id:16][role:1][pk_hash:4]
 */
function parseFullPayload(bytes: Uint8Array): BLEAdvertisementData | null {
  if (bytes.length !== AD_PAYLOAD_SIZE_FULL) return null;

  const device_id = Buffer.from(bytes.slice(2, 18)).toString('hex');
  const role = bytes[18];
  const public_key_hash = Buffer.from(bytes.slice(19, 23)).toString('hex');

  return {
    device_id,
    role: BLE_ROLE_BYTE_MAP[role] ?? 'unknown',
    public_key_hash,
    rssi: undefined,
    payload_tier: 'full',
  };
}

/**
 * Parse a TRIMMED 21-byte manufacturer data packet (from legacy BLE advertising).
 *
 * Format: [magic:2][device_id:16][role:1][pk_hash:2]
 * - pk_hash is only the first 2 bytes (less precise, but verified later in handshake)
 */
function parseTrimmedPayload(bytes: Uint8Array): BLEAdvertisementData | null {
  if (bytes.length !== AD_PAYLOAD_SIZE_TRIMMED) return null;

  const device_id = Buffer.from(bytes.slice(2, 18)).toString('hex');
  const role = bytes[18];
  const public_key_hash = Buffer.from(bytes.slice(19, 21)).toString('hex');

  return {
    device_id,
    role: BLE_ROLE_BYTE_MAP[role] ?? 'unknown',
    public_key_hash,
    rssi: undefined,
    payload_tier: 'trimmed',
  };
}

/**
 * Validates the magic prefix and dispatches to the correct payload parser.
 *
 * Returns null for:
 * - Non-app packets (wrong magic prefix)
 * - Unrecognized payload sizes
 * - Parse errors
 */
export function parseAdvertisementPacket(data: string | Uint8Array | number[]): BLEAdvertisementData | null {
  try {
    let bytes: Uint8Array;
    if (typeof data === 'string') {
      // Could be hex or base64 encoded
      if (data.length === AD_PAYLOAD_SIZE_FULL * 2 || data.length === AD_PAYLOAD_SIZE_TRIMMED * 2) {
        bytes = new Uint8Array(data.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
      } else {
        bytes = new Uint8Array(Buffer.from(data, 'base64'));
      }
    } else if (Array.isArray(data)) {
      bytes = new Uint8Array(data);
    } else {
      bytes = new Uint8Array(data);
    }

    // Validate magic prefix — if it doesn't match, this isn't our app's packet
    if (bytes.length < 2 || bytes[0] !== DISASTER_P2P_MAGIC[0] || bytes[1] !== DISASTER_P2P_MAGIC[1]) {
      return null; // Not our app — silently ignore
    }

    // Dispatch to correct parser based on size
    if (bytes.length === AD_PAYLOAD_SIZE_FULL) {
      return parseFullPayload(bytes);
    } else if (bytes.length === AD_PAYLOAD_SIZE_TRIMMED) {
      return parseTrimmedPayload(bytes);
    }

    // Unknown size — could be a future protocol version, ignore for now
    return null;
  } catch (error) {
    logger.error('BLE', 'Error parsing advertisement packet', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Callback when a peripheral is discovered.
 * Extract manufacturer data without connecting.
 *
 * Since we no longer broadcast a service UUID (to save 18 bytes in the
 * advertising packet), filtering is done via the magic prefix inside
 * the manufacturer data payload instead.
 */
function onDiscoverPeripheral(peripheral: any): void {
  try {
    const advertising = peripheral.advertising;
    if (!advertising) return;

    // Extract manufacturer data using our specific manufacturer ID key
    // Android DefaultPeripheral.java uses String.format("%04x", key) to build the key,
    // so the key is a 4-digit hex string like "ffff".
    let payloadBytes: number[] | undefined;
    const mfgIdKey = DISASTER_P2P_MANUFACTURER_ID.toString(16).padStart(4, '0'); // "ffff" — matches Android DefaultPeripheral.java hex format
    
    // Path 1: Try our specific manufacturer ID key first (correct, prefix-free path)
    if (advertising.manufacturerData?.[mfgIdKey]?.bytes) {
      payloadBytes = advertising.manufacturerData[mfgIdKey].bytes;
      console.log(`[BLE] Extracted via manufacturerData[${mfgIdKey}].bytes (length=${payloadBytes!.length})`);
    } else if (advertising.manufacturerRawData?.bytes) {
      // Path 2: Fallback to raw data, slicing off the 4-byte manufacturer-ID prefix
      payloadBytes = advertising.manufacturerRawData.bytes.slice(4);
      console.log(`[BLE] Extracted via manufacturerRawData.bytes.slice(4) (length=${payloadBytes!.length})`);
    } else if (advertising.manufacturerData) {
      // Path 3: Fallback — try first key (for compatibility)
      const keys = Object.keys(advertising.manufacturerData);
      if (keys.length > 0 && advertising.manufacturerData[keys[0]]?.bytes) {
        payloadBytes = advertising.manufacturerData[keys[0]].bytes;
        console.log(`[BLE] Extracted via manufacturerData[${keys[0]}].bytes fallback (length=${payloadBytes!.length})`);
      } else if (Array.isArray(advertising.manufacturerData)) {
        payloadBytes = advertising.manufacturerData;
        console.log(`[BLE] Extracted via manufacturerData array fallback (length=${payloadBytes!.length})`);
      }
    }

    if (!payloadBytes) {
      // No manufacturer data at all — not our peer
      return;
    }

    // Filter by RSSI — only process advertisements from nearby devices
    // RSSI < -90 dBm is too weak for Wi-Fi Direct connection
    const rssi = peripheral.rssi ?? 0;
    if (rssi < -90) {
      return; // Too far away — skip
    }

    // Parse the payload (magic prefix validation happens inside parseAdvertisementPacket)
    const parsed = parseAdvertisementPacket(payloadBytes);
    if (!parsed) {
      // Distinguish failure reason for debugging
      if (payloadBytes.length >= 2 && payloadBytes[0] === 0x44 && payloadBytes[1] === 0x50) {
        console.log(`[BLE] parseAdvertisementPacket returned null despite valid magic prefix — size mismatch (got ${payloadBytes.length} bytes, expected 21 or 23)`);
      } else {
        console.log(`[BLE] parseAdvertisementPacket returned null — not our app (magic prefix mismatch or no data). First bytes: [${payloadBytes.slice(0, 4).join(',')}], length=${payloadBytes.length}`);
      }
      return;
    }

    const now = Date.now();
    const lastProcessed = lastProcessedAtMs.get(parsed.device_id) || 0;
    if (now - lastProcessed < 1000) {
      return;
    }
    lastProcessedAtMs.set(parsed.device_id, now);

    // Add RSSI and name for logging
    const adData: BLEAdvertisementData = {
      ...parsed,
      rssi: peripheral.rssi || 0,
      name: peripheral.advertising?.localName,
    };

    logger.info('BLE', `Peer: ${adData.device_id.slice(0, 8)} role=${adData.role} rssi=${adData.rssi} tier=${adData.payload_tier}`);

    // Emit event for PeerRegistry to consume
    handleAdvertisementReceived(adData);
  } catch (error) {
    logger.error('BLE', 'onDiscoverPeripheral failed', error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Callback when BLE state changes.
 */
let lastKnownState: string | null = null;
function onBleStateChange(state: string): void {
  logger.info('BLE', `State changed: ${state}`);
  if (state === 'off') {
    lastKnownState = 'off';
    logger.warn('BLE', 'Bluetooth turned off');
    stopScanning();
  } else if (state === 'on') {
    const wasOff = lastKnownState === 'off';
    lastKnownState = 'on';
    logger.info('BLE', 'Bluetooth turned on');
    if (wasOff && isScanning && !cycleInFlight) {
      if (scanTimer) clearTimeout(scanTimer);
      executeScanCycle();
    }
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
    peripheralListener = BleManager.onDiscoverPeripheral((event: any) => onDiscoverPeripheral(event));

    // Subscribe to BLE state change events
    if (stateListener) {
      stateListener.remove();
    }
    stateListener = BleManager.onDidUpdateState((args: any) => onBleStateChange(args.state));

    if (stopListener) {
      stopListener.remove();
    }
    stopListener = BleManager.onStopScan((args: any) => {
      // Decode numeric failure code if it's a failure (e.g., from Android's ScanCallback.onScanFailed)
      if (args && args.status) {
        if (args.status === 10) {
          // Status 10 means the scan stopped normally (e.g., timeout or our manual stop)
          return;
        }
        const errorCodes: Record<number, string> = {
          1: 'SCAN_FAILED_ALREADY_STARTED',
          2: 'SCAN_FAILED_APPLICATION_REGISTRATION_FAILED',
          3: 'SCAN_FAILED_INTERNAL_ERROR',
          4: 'SCAN_FAILED_FEATURE_UNSUPPORTED',
        };
        logger.error('BLE', `Scan stopped with failure code: ${args.status} (${errorCodes[args.status] || 'UNKNOWN'})`);
      }
    });

    isScanning = true;
    logger.info('BLE', 'Starting continuous scan session');

    // Start the continuous scan cycle
    await executeScanCycle();
  } catch (error) {
    logger.error('BLE', 'startScanning failed', error instanceof Error ? error : new Error(String(error)));
    isScanning = false;
    throw error;
  }
}

/**
 * Execute one continuous scan cycle.
 */
const SCAN_ACTIVE_MS = 8000;  // 8s scan (up from 4s)
const SCAN_SLEEP_MS = 2000;   // 2s sleep (down from 8s) → 80% duty cycle

let cycleInFlight = false;

async function executeScanCycle(): Promise<void> {
  if (!isScanning || cycleInFlight) return;
  cycleInFlight = true;

  try {
    logger.debug('BLE', 'Starting BLE scan cycle (active)');
    await BleManager.scan({
      serviceUUIDs: [], // Scan all devices — filtering is done via magic prefix in manufacturer data
      seconds: 0,       // don't let native auto-stop; we control timing ourselves
      allowDuplicates: true, // We want continuous updates
      matchMode: 2, // MATCH_MODE_AGGRESSIVE
      scanMode: 2,  // SCAN_MODE_LOW_LATENCY — fastest discovery at expense of battery
      legacy: false, // Experiment: accept both legacy (BLE 4.x) and extended (BLE 5.0) advertisements
    });

    console.log('[BLE] Scan started with legacy=true (accepting both BLE 4.x and 5.0 advertisements)');

    await new Promise(resolve => { scanTimer = setTimeout(resolve, SCAN_ACTIVE_MS); });
    
    if (!isScanning) return;
    await BleManager.stopScan().catch(() => {});
    
    if (!isScanning) return;
    logger.debug('BLE', 'Sleeping BLE scan cycle (idle)');
    await new Promise(resolve => { scanTimer = setTimeout(resolve, SCAN_SLEEP_MS); });

    if (!isScanning) return;
    scanTimer = setTimeout(executeScanCycle, 0);
  } catch (error) {
    logger.error('BLE', 'Error during scan cycle', error instanceof Error ? error : new Error(String(error)));
    if (isScanning) {
      // Retry after a delay if it failed to start
      scanTimer = setTimeout(executeScanCycle, 5000);
    }
  } finally {
    cycleInFlight = false;
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
    if (stopListener) {
      stopListener.remove();
      stopListener = null;
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
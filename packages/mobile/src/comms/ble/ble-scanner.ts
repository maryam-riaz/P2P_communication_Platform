import { BleManager, Device } from 'react-native-ble-plx';
import { BleDevice, DISASTER_P2P_SERVICE_UUID, UserRole } from './ble-types';

/**
 * Converts a 16-byte Uint8Array to a UUID string with dashes.
 */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error('UUID bytes must be exactly 16 bytes');
  }
  const hexParts: string[] = [];
  for (let i = 0; i < 16; i++) {
    hexParts.push(bytes[i].toString(16).padStart(2, '0'));
  }
  const hex = hexParts.join('');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32),
  ].join('-');
}

/**
 * Unpacks a 25-byte advertisement data payload.
 */
export function unpackAdvertisementPayload(payload: Uint8Array): {
  deviceId: string;
  role: UserRole;
  publicKeyHash: string;
  timestamp: number;
} {
  if (payload.length !== 25) {
    throw new Error(`Invalid BLE ad payload length: ${payload.length} bytes (expected 25)`);
  }

  // 1. Unpack Device ID (16 bytes)
  const deviceId = bytesToUuid(payload.subarray(0, 16));

  // 2. Unpack Role (1 byte)
  const roleVal = payload[16];
  let role: UserRole = 'user';
  if (roleVal === 1) role = 'responder';
  if (roleVal === 2) role = 'admin';

  // 3. Unpack Public Key Hash (4 bytes)
  const hashParts: string[] = [];
  for (let i = 17; i < 21; i++) {
    hashParts.push(payload[i].toString(16).padStart(2, '0'));
  }
  const publicKeyHash = hashParts.join('');

  // 4. Unpack Timestamp (4 bytes)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const timestamp = view.getUint32(21, false); // Big endian

  return { deviceId, role, publicKeyHash, timestamp };
}

export class BleScanner {
  private isScanning = false;
  private scanTimer: any = null;
  private windowTimer: any = null;
  private bleManager: BleManager;

  constructor(private onPeerDiscovered: (device: BleDevice) => void) {
    this.bleManager = new BleManager();
  }

  /**
   * Starts BLE scanning with a 5-second interval and a 2-second active window
   * to conserve battery power on mobile hardware.
   *
   * Filters on DISASTER_P2P_SERVICE_UUID so only app peers are surfaced.
   * On advertisement received, manufacturer data bytes are unpacked via
   * unpackAdvertisementPayload() and delivered to the onPeerDiscovered callback.
   */
  startScanning(): void {
    if (this.isScanning) return;
    this.isScanning = true;
    console.log('[BLE Scanner] Scan loop started: 5s interval, 2s window');

    const startScanWindow = () => {
      console.log('[BLE Scanner] Scanning active window started (2 seconds)...');

      // Start real BLE scan, filtered to our disaster P2P service UUID
      this.bleManager.startDeviceScan(
        [DISASTER_P2P_SERVICE_UUID],
        { allowDuplicates: false },
        (error, device) => {
          if (error) {
            console.error('[BLE Scanner] Scan error:', error);
            return;
          }
          if (device) {
            this.handleDiscoveredDevice(device);
          }
        }
      );

      // Stop scanning after the 2-second window
      this.windowTimer = setTimeout(() => {
        this.bleManager.stopDeviceScan();
        console.log('[BLE Scanner] Scanning active window finished. Entering sleep mode...');
      }, 2000);
    };

    // Run first scan window immediately
    startScanWindow();

    // Schedule subsequent scan windows every 5 seconds
    this.scanTimer = setInterval(() => {
      startScanWindow();
    }, 5000);
  }

  /**
   * Stops BLE scanning and clears scheduling timers.
   */
  stopScanning(): void {
    if (!this.isScanning) return;
    this.isScanning = false;

    this.bleManager.stopDeviceScan();

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    console.log('[BLE Scanner] Scanning stopped.');
  }

  /**
   * Parses a discovered BLE device from react-native-ble-plx.
   * Extracts manufacturer data from the advertisement and passes it
   * through the existing unpackAdvertisementPayload() pipeline.
   */
  private handleDiscoveredDevice(device: Device): void {
    try {
      // react-native-ble-plx exposes manufacturerData as a base64 string
      const rawBase64 = device.manufacturerData;
      if (!rawBase64) return;

      const rawBytes = new Uint8Array(Buffer.from(rawBase64, 'base64'));

      // Manufacturer data starts with a 2-byte company ID prefix — skip it
      // to reach our 25-byte custom payload
      const payloadStart = rawBytes.length > 25 ? rawBytes.length - 25 : 0;
      const payload = rawBytes.subarray(payloadStart);

      this.onAdvertisementReceived(payload, device.rssi ?? -100);
    } catch (error) {
      console.error('[BLE Scanner] Error parsing discovered device:', error);
    }
  }

  /**
   * Decodes and delivers a raw advertisement data payload to the app callback.
   * Also callable directly in tests via the existing test harness.
   */
  onAdvertisementReceived(rawManufacturerData: Uint8Array, rssi: number): void {
    try {
      const unpacked = unpackAdvertisementPayload(rawManufacturerData);
      this.onPeerDiscovered({
        deviceId: unpacked.deviceId,
        role: unpacked.role,
        publicKeyHash: unpacked.publicKeyHash,
        timestamp: unpacked.timestamp,
        rssi,
        lastSeen: Date.now(),
      });
    } catch (error) {
      console.error('[BLE Scanner] Error unpacking discovered advertisement', error);
    }
  }

  /**
   * Releases BLE resources. Call when the component using this is unmounted.
   */
  destroy(): void {
    this.stopScanning();
    this.bleManager.destroy();
  }

  status(): boolean {
    return this.isScanning;
  }
}

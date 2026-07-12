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

  startScanning(): void {
    if (this.isScanning) return;
    this.isScanning = true;
    console.log('[BLE Scanner] Continuous scanning started.');

    // Start BLE scan. We pass null filter to bypass Android's 128-bit UUID filtering bugs on some devices,
    // and use allowDuplicates: true to ensure the map gets real-time signal strength (RSSI) updates.
    this.bleManager.startDeviceScan(
      null,
      { allowDuplicates: true },
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
  }

  /**
   * Stops BLE scanning and clears scheduling timers.
   */
  stopScanning(): void {
    if (!this.isScanning) return;
    this.isScanning = false;

    this.bleManager.stopDeviceScan();
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

      const binary = atob(rawBase64);
      const rawBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        rawBytes[i] = binary.charCodeAt(i);
      }

      // Check if advertisement starts with our test/development company ID (0xFFFF)
      // and is exactly 27 bytes (2 bytes company ID + 25 bytes custom payload)
      if (rawBytes.length === 27 && rawBytes[0] === 0xFF && rawBytes[1] === 0xFF) {
        console.log(`[BLE Scanner] Match found! MAC: ${device.id}, RSSI: ${device.rssi}`);
        const payload = rawBytes.subarray(2); // Skip company ID
        this.onAdvertisementReceived(payload, device.rssi ?? -100);
      }
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

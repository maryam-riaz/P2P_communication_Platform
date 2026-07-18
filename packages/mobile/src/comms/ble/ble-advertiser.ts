import { NativeModules } from 'react-native';
import {
  DISASTER_P2P_MAGIC,
  AD_PAYLOAD_SIZE_FULL,
  AD_PAYLOAD_SIZE_TRIMMED,
  BLE_ROLE_BYTE_MAP,
  type UserRole,
  type BleAdvertiseResult,
  type BleAdvertiseCapability,
} from './ble-types';

const { BleAdvertiser: NativeBleAdvertiser } = NativeModules;

/**
 * Converts a UUID string (36 chars with dashes) to a 16-byte Uint8Array.
 */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error('Invalid UUID length');
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Packs the FULL manufacturer data payload (27 bytes) for BLE 5.0 extended advertising.
 *
 * Payload format:
 * - magic:          2 bytes (0xD2 0x50 — app identification)
 * - device_id:     16 bytes (UUID)
 * - role:           1 byte  (0 = victim, 1 = rescuer, 2 = admin)
 * - public_key_hash: 4 bytes (first 4 bytes of SHA-256(pubkey))
 */
export function packFullPayload(
  deviceId: string,
  role: UserRole,
  publicKeyHashHex: string
): Uint8Array {
  const payload = new Uint8Array(AD_PAYLOAD_SIZE_FULL);

  // 1. Magic prefix (2 bytes)
  payload[0] = DISASTER_P2P_MAGIC[0];
  payload[1] = DISASTER_P2P_MAGIC[1];

  // 2. Device ID (16 bytes)
  const uuidBytes = uuidToBytes(deviceId);
  payload.set(uuidBytes, 2);

  // 3. Role (1 byte)
  const idx = BLE_ROLE_BYTE_MAP.indexOf(role);
  payload[18] = idx !== -1 ? idx : 2;

  // 4. Public Key Hash (4 bytes)
  const pkHex = publicKeyHashHex.padStart(8, '0');
  for (let i = 0; i < 4; i++) {
    payload[19 + i] = parseInt(pkHex.substring(i * 2, i * 2 + 2), 16);
  }

  return payload;
}

/**
 * Packs the TRIMMED manufacturer data payload (23 bytes) for legacy BLE advertising.
 *
 * Fits within the 31-byte legacy BLE limit:
 *   3 (flags) + 1+1+2+23 (manufacturer data AD) = 30/31 bytes (1 byte margin)
 *
 * Payload format:
 * - magic:          2 bytes (0xD2 0x50 — app identification)
 * - device_id:     16 bytes (UUID)
 * - role:           1 byte  (0 = victim, 1 = rescuer, 2 = admin)
 * - public_key_hash: 2 bytes (first 2 bytes of SHA-256(pubkey))
 */
export function packTrimmedPayload(
  deviceId: string,
  role: UserRole,
  publicKeyHashHex: string
): Uint8Array {
  const payload = new Uint8Array(AD_PAYLOAD_SIZE_TRIMMED);

  // 1. Magic prefix (2 bytes)
  payload[0] = DISASTER_P2P_MAGIC[0];
  payload[1] = DISASTER_P2P_MAGIC[1];

  // 2. Device ID (16 bytes)
  const uuidBytes = uuidToBytes(deviceId);
  payload.set(uuidBytes, 2);

  // 3. Role (1 byte)
  const idx = BLE_ROLE_BYTE_MAP.indexOf(role);
  payload[18] = idx !== -1 ? idx : 2;

  // 4. Public Key Hash — truncated to 2 bytes
  const pkHex = publicKeyHashHex.padStart(8, '0');
  for (let i = 0; i < 2; i++) {
    payload[19 + i] = parseInt(pkHex.substring(i * 2, i * 2 + 2), 16);
  }

  return payload;
}

/**
 * Encodes a Uint8Array to Base64 string.
 * Works in both React Native (with btoa) and Node.js (with Buffer).
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class BleAdvertiser {
  private isAdvertising = false;
  private capability: BleAdvertiseCapability = 'scan_only';

  constructor(
    private deviceId: string,
    private role: UserRole,
    private publicKeyHash: string,
    private displayName: string
  ) {}

  /**
   * Starts BLE peripheral advertising via the native BleAdvertiserModule (Kotlin).
   *
   * The native module implements a tiered advertising strategy:
   *   1. BLE 5.0 Extended Advertising (full 27-byte payload)
   *   2. Legacy BLE Advertising (trimmed 23-byte payload)
   *   3. Scan-only mode (device cannot advertise)
   *
   * In non-native environments (Jest / Node.js), the NativeBleAdvertiser will be null
   * and advertising is simulated with a console log so tests can still run.
   *
   * Requires BLUETOOTH_ADVERTISE permission on Android 12+ (API 31+).
   */
  async startAdvertising(): Promise<BleAdvertiseCapability> {
    if (this.isAdvertising) return this.capability;

    const fullPayload = packFullPayload(this.deviceId, this.role, this.publicKeyHash);
    const trimmedPayload = packTrimmedPayload(this.deviceId, this.role, this.publicKeyHash);

    const payloadFullBase64 = toBase64(fullPayload);
    const payloadTrimmedBase64 = toBase64(trimmedPayload);

    if (!NativeBleAdvertiser) {
      // Non-native environment (e.g. Jest/Node.js test runner)
      this.isAdvertising = true;
      this.capability = 'extended'; // Simulate best case
      console.log(
        `[BLE Advertiser] Advertising started (simulated). Role: ${this.role}, ID: ${this.deviceId}`
      );
      return this.capability;
    }

    try {
      const result: BleAdvertiseResult = await NativeBleAdvertiser.startAdvertising(
        payloadFullBase64,
        payloadTrimmedBase64
      );

      this.capability = result.capability;

      if (this.capability === 'scan_only') {
        // Device cannot advertise — this is not an error, just a capability limitation.
        // The device can still discover peers via scanning.
        this.isAdvertising = false;
        console.warn(
          `[BLE Advertiser] Device does not support BLE advertising. Running in scan-only mode.`
        );
      } else {
        this.isAdvertising = true;
        console.log(
          `[BLE Advertiser] Advertising started (${this.capability}). Role: ${this.role}, ID: ${this.deviceId}`
        );
      }

      return this.capability;
    } catch (error: any) {
      this.isAdvertising = false;
      this.capability = 'scan_only';

      // If DATA_TOO_LARGE on legacy, log actionable info instead of a generic error
      if (error?.message === 'DATA_TOO_LARGE') {
        console.error(
          '[BLE Advertiser] DATA_TOO_LARGE: even the trimmed payload exceeds this device\'s advertising capacity. ' +
          'This device will operate in scan-only mode.'
        );
        // Don't throw — degrade to scan-only
        return 'scan_only';
      }

      console.error('[BLE Advertiser] Failed to start advertising:', error);
      throw error;
    }
  }

  /**
   * Stops BLE peripheral advertising.
   */
  async stopAdvertising(): Promise<void> {
    if (!this.isAdvertising) return;
    try {
      if (NativeBleAdvertiser) {
        await NativeBleAdvertiser.stopAdvertising();
      }
    } catch (error) {
      console.warn('[BLE Advertiser] Error stopping advertising:', error);
    } finally {
      this.isAdvertising = false;
      this.capability = 'scan_only';
      console.log('[BLE Advertiser] Advertising stopped.');
    }
  }

  /**
   * Returns the current advertising capability tier.
   */
  getCapability(): BleAdvertiseCapability {
    return this.capability;
  }

  /**
   * Returns whether the advertiser is currently active.
   */
  status(): boolean {
    return this.isAdvertising;
  }
}

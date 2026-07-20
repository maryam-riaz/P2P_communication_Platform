import { NativeModules } from 'react-native';
import { DISASTER_P2P_SERVICE_UUID, UserRole } from './ble-types';
import { logger } from '../../utils/logger';

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
 * Packs the custom manufacturer data payload (25 bytes).
 * Payload format:
 * - device_id: 16 bytes (UUID)
 * - role: 1 byte (0 = user, 1 = responder, 2 = admin)
 * - public_key_hash: 4 bytes (hex SHA-256 hash of public key)
 * - timestamp: 4 bytes (unix epoch seconds, big-endian)
 */
export function packAdvertisementPayload(
  deviceId: string,
  role: UserRole,
  publicKeyHashHex: string,
  timestampSeconds: number
): Uint8Array {
  const payload = new Uint8Array(25);

  // 1. Pack Device ID (16 bytes)
  const uuidBytes = uuidToBytes(deviceId);
  payload.set(uuidBytes, 0);

  // 2. Pack Role (1 byte)
  const roleVal = role === 'user' ? 0 : role === 'responder' ? 1 : 2;
  payload[16] = roleVal;

  // 3. Pack Public Key Hash (4 bytes)
  const pkHex = publicKeyHashHex.padStart(8, '0');
  const pkHashBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    pkHashBytes[i] = parseInt(pkHex.substring(i * 2, i * 2 + 2), 16);
  }
  payload.set(pkHashBytes, 17);

  // 4. Pack Timestamp (4 bytes, big endian)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint32(21, timestampSeconds, false);

  return payload;
}

export class BleAdvertiser {
  private isAdvertising = false;

  constructor(
    private deviceId: string,
    private role: UserRole,
    private publicKeyHash: string,
    private displayName: string
  ) {}

  /**
   * Starts BLE peripheral advertising via the native BleAdvertiserModule (Kotlin).
   *
   * The native module (BleAdvertiserModule.kt) uses Android's BluetoothLeAdvertiser
   * to broadcast the 25-byte manufacturer data payload with the disaster P2P service UUID.
   *
   * In non-native environments (Jest / Node.js), the NativeBleAdvertiser will be null
   * and advertising is simulated with a console log so tests can still run.
   *
   * Requires BLUETOOTH_ADVERTISE permission on Android 12+ (API 31+).
   */
  async startAdvertising(): Promise<void> {
    if (this.isAdvertising) return;

    const payloadBytes = this.getSerializedPayload();
    let binary = '';
    for (let i = 0; i < payloadBytes.length; i++) {
      binary += String.fromCharCode(payloadBytes[i]);
    }
    const payloadBase64 = btoa(binary);
    
    // Sanitize display name to keep it alphanumeric and short to fit BLE limits (max 31 bytes total)
    const sanitizedName = this.displayName.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 10);
    const localName = `DP2P:${sanitizedName}:${this.deviceId.substring(0, 8)}`;

    if (!NativeBleAdvertiser) {
      // Non-native environment (e.g. Jest/Node.js test runner)
      this.isAdvertising = true;
      logger.ble.info('Advertising started (simulated)', { role: this.role, deviceId: this.deviceId });
      return;
    }

    try {
      await NativeBleAdvertiser.startAdvertising(payloadBase64, localName);
      this.isAdvertising = true;
      logger.ble.info('Advertising started', { role: this.role, deviceId: this.deviceId });
    } catch (error) {
      this.isAdvertising = false;
      logger.ble.error('Failed to start advertising', { error: String(error) });
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
      logger.ble.warn('Error stopping advertising', { error: String(error) });
    } finally {
      this.isAdvertising = false;
      logger.ble.info('Advertising stopped');
    }
  }

  /**
   * Generates the serialized 25-byte advertising data payload.
   */
  getSerializedPayload(): Uint8Array {
    const nowSecs = Math.floor(Date.now() / 1000);
    return packAdvertisementPayload(this.deviceId, this.role, this.publicKeyHash, nowSecs);
  }

  status(): boolean {
    return this.isAdvertising;
  }
}

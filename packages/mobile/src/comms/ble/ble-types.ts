/**
 * TypeScript types for BLE discovery and react-native-ble-manager
 */

// ─── Shared BLE Constants ─────────────────────────────────────────────────────
// These must stay in sync with BleAdvertiserModule.kt

/**
 * 2-byte magic prefix for app identification inside manufacturer data.
 * Replaces the 128-bit Service UUID (which cost 18 bytes in the advertising packet).
 * 0xD2 0x50 = "D"isaster "P"2P
 */
export const DISASTER_P2P_MAGIC = [0xD2, 0x50] as const;

/**
 * BLE manufacturer ID. 0xFFFF = Bluetooth SIG "test/development" ID.
 * Must match MANUFACTURER_ID in BleAdvertiserModule.kt.
 *
 * WARNING: 0xFFFF must not be used in production/shipping apps.
 * For production, register a real company ID with the Bluetooth SIG,
 * or rely on the magic prefix for app discrimination.
 */
export const DISASTER_P2P_MANUFACTURER_ID = 0xFFFF;

/**
 * Full payload size: [magic:2][device_id:16][role:1][pk_hash:4][timestamp:4] = 27 bytes
 * Used on BLE 5.0 extended advertising (up to 1650 bytes, no size concern).
 */
export const AD_PAYLOAD_SIZE_FULL = 27;

/**
 * Trimmed payload size: [magic:2][device_id:16][role:1][pk_hash:2][timestamp:2] = 23 bytes
 * Used on legacy BLE advertising (31-byte limit).
 * Packet total: 3 (flags) + 1+1+2+23 (mfg data AD) = 30/31 bytes.
 */
export const AD_PAYLOAD_SIZE_TRIMMED = 23;

/**
 * Advertising capability tiers reported by the native module.
 * Must match the strings in BleAdvertiserModule.kt.
 */
export type BleAdvertiseCapability = 'extended' | 'legacy' | 'trimmed' | 'scan_only';

/**
 * Result returned from the native BleAdvertiser.startAdvertising() call.
 */
export interface BleAdvertiseResult {
  capability: BleAdvertiseCapability;
}

/**
 * Result from BleAdvertiser.getAdvertisingCapabilities().
 */
export interface BleAdvertisingCapabilities {
  canAdvertise: boolean;
  supportsExtended: boolean;
  isCurrentlyAdvertising: boolean;
  currentCapability: string;
}

// ─── User Role ────────────────────────────────────────────────────────────────

/**
 * Re-export UserRole from authSlice for BLE module convenience.
 * Canonical definition lives in redux/slices/authSlice.ts.
 */
export type { UserRole } from '../../redux/slices/authSlice';

// ─── BLE Advertisement Data ──────────────────────────────────────────────────

export interface BLEAdvertisementData {
  device_id: string;      // 16-byte UUID as hex string
  role: 'victim' | 'rescuer' | 'admin' | 'unknown';
  public_key_hash: string; // pk_hash as hex (4 bytes full, 2 bytes trimmed)
  timestamp: number;       // Unix seconds (full) or relative minutes (trimmed)
  rssi?: number;          // received signal strength indicator (optional)
  name?: string;          // peripheral name (optional)
  payload_tier?: 'full' | 'trimmed'; // which payload variant was parsed
}

export interface DiscoveredPeer extends BLEAdvertisementData {
  id: string;             // unique ID within our registry
  discovered_at: number;  // timestamp of discovery
  last_seen: number;      // timestamp of last seen (updated on each advertisement)
}

/**
 * Type definitions for react-native-ble-manager
 * (This module doesn't have great TS support, so we define these ourselves)
 */

export interface BleManagerScanOptions {
  matchMode?: number;     // MATCH_MODE_AGGRESSIVE = 2
  scanMode?: number;      // SCAN_MODE_LOW_LATENCY = 1
}

export interface BleManagerPeripheral {
  id: string;
  name?: string;
  rssi: number;
  advertising: {
    localName?: string;
    txPowerLevel?: number;
    manufacturerData?: string | Uint8Array; // hex string or raw bytes
    serviceUUIDs?: string[];
    isConnectable?: boolean;
  };
}

export interface BleManagerEventData {
  peripheral?: BleManagerPeripheral;
  state?: string;         // 'on', 'off', 'unknown', 'resetting'
}

/**
 * Session state for a discovered peer.
 */
export interface BleSessionState {
  peer: DiscoveredPeer;
  handshake_status: 'pending' | 'in_progress' | 'completed' | 'failed';
  error?: Error;
}

/**
 * BLE transport events
 */
export type BleTransportEvent =
  | { type: 'peer_discovered'; peer: DiscoveredPeer }
  | { type: 'peer_lost'; peer_id: string }
  | { type: 'handshake_started'; peer_id: string }
  | { type: 'handshake_completed'; peer_id: string }
  | { type: 'handshake_failed'; peer_id: string; error: string }
  | { type: 'ble_state_changed'; state: string }
  | { type: 'scan_error'; error: string };

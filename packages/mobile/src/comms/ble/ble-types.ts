/**
 * TypeScript types for BLE discovery and react-native-ble-manager
 */

export interface BLEAdvertisementData {
  device_id: string;      // 16-byte UUID as hex string
  role: 'victim' | 'rescuer' | 'admin' | 'unknown';
  public_key_hash: string; // first 4 bytes of SHA-256(pubkey) as hex
  timestamp: number;       // Unix seconds
  rssi?: number;          // received signal strength indicator (optional)
  name?: string;          // peripheral name (optional)
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

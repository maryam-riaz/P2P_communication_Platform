export type UserRole = 'user' | 'responder' | 'admin';

export interface BleDevice {
  deviceId: string;       // 16-byte UUID representation
  role: UserRole;         // parsed role enum
  publicKeyHash: string;  // 4-byte hash (hex string) for filtering
  timestamp: number;      // Epoch timestamp when advertised
  rssi: number;           // signal strength indicator
  lastSeen: number;       // system timestamp when scanned
}

// Custom Service UUID for the Disaster P2P Application discovery channel
export const DISASTER_P2P_SERVICE_UUID = '550e8400-e29b-41d4-a716-446655440000';

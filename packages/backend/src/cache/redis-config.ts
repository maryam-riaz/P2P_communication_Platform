import { createClient } from 'redis';

// Redis Key Generator helper to prevent hardcoding pattern keys across layers
export const RedisKeys = {
  /**
   * Key: device:${device_id}:reachable
   * Type: string
   * Value: ISO timestamp or Unix timestamp (representing last heartbeat)
   * TTL: 30-60 seconds (determines offline status dynamically)
   */
  deviceReachable: (deviceId: string) => `device:${deviceId}:reachable`,

  /**
   * Key: rescuer:${rescuer_id}:available
   * Type: string (or Hash)
   * Value: boolean (true/false) or status enum ('available' | 'busy' | 'offline')
   */
  rescuerAvailable: (rescuerId: string) => `rescuer:${rescuerId}:available`,

  /**
   * Key: incident:${incident_id}:watchers
   * Type: Set
   * Value: Set of Rescuer IDs (observing this specific incident in real-time)
   */
  incidentWatchers: (incidentId: string) => `incident:${incidentId}:watchers`,
};

export interface RedisConfig {
  url: string;
  socket?: {
    reconnectStrategy: (retries: number) => number;
  };
}

export function createRedisClient(config: RedisConfig) {
  return createClient({
    url: config.url,
    socket: config.socket || {
      reconnectStrategy: (retries: number) => {
        // Linear backoff logic
        return Math.min(retries * 50, 2000);
      }
    }
  });
}

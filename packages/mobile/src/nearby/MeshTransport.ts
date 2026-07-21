import { Platform } from 'react-native';
import { nearbyConnections } from './NearbyConnections';
import { database, Message } from '../db';

const SERVICE_ID = 'com.mojojojoo.sosifyapp.p2p';

export interface TransportEvent {
  endpointId: string;
  data?: string;
  displayName?: string;
}

type EventHandler = (event: TransportEvent) => void;

/**
 * Unified P2P transport abstraction over platform-specific native modules.
 *
 * Android → Nearby Connections API
 * iOS     → Multipeer Connectivity (stub)
 */
class MeshTransport {
  private listeners: { event: string; handler: EventHandler }[] = [];

  async startAdvertising(): Promise<boolean> {
    if (Platform.OS === 'android') {
      return nearbyConnections.startAdvertising(SERVICE_ID);
    }
    throw new Error('iOS transport not yet available on this device');
  }

  async startDiscovery(): Promise<boolean> {
    if (Platform.OS === 'android') {
      return nearbyConnections.startDiscovery(SERVICE_ID);
    }
    throw new Error('iOS transport not yet available on this device');
  }

  async sendToAll(data: string): Promise<void> {
    if (Platform.OS === 'android') {
      return nearbyConnections.sendPayloadToAll(data);
    }
    throw new Error('iOS transport not yet available on this device');
  }

  async stopAll(): Promise<void> {
    if (Platform.OS === 'android') {
      return nearbyConnections.stopAll();
    }
  }

  async getConnectedPeers(): Promise<string[]> {
    if (Platform.OS === 'android') {
      return nearbyConnections.getConnectedEndpoints();
    }
    return [];
  }

  onFound(handler: EventHandler) {
    if (Platform.OS === 'android') {
      const unsub = nearbyConnections.onEndpointFound((e) => {
        handler({ endpointId: e.endpointId, displayName: e.endpointName });
      });
      this.listeners.push({ event: 'found', handler });
      return unsub;
    }
    return () => {};
  }

  onLost(handler: EventHandler) {
    if (Platform.OS === 'android') {
      const unsub = nearbyConnections.onEndpointLost((e) => {
        handler({ endpointId: e.endpointId });
      });
      this.listeners.push({ event: 'lost', handler });
      return unsub;
    }
    return () => {};
  }

  onData(handler: EventHandler) {
    if (Platform.OS === 'android') {
      const unsub = nearbyConnections.onPayloadReceived((e) => {
        handler({ endpointId: e.endpointId, data: e.data });
      });
      this.listeners.push({ event: 'data', handler });
      return unsub;
    }
    return () => {};
  }

  onConnected(handler: EventHandler) {
    if (Platform.OS === 'android') {
      const unsub = nearbyConnections.onEndpointConnected((e) => {
        handler({ endpointId: e.endpointId });
      });
      this.listeners.push({ event: 'connected', handler });
      return unsub;
    }
    return () => {};
  }

  onDisconnected(handler: EventHandler) {
    if (Platform.OS === 'android') {
      const unsub = nearbyConnections.onEndpointDisconnected((e) => {
        handler({ endpointId: e.endpointId });
      });
      this.listeners.push({ event: 'disconnected', handler });
      return unsub;
    }
    return () => {};
  }

  /**
   * Persists a received payload to WatermelonDB as a message record.
   * Validates the end-to-end path: native transport → JS → local DB.
   */
  async persistReceivedMessage(endpointId: string, base64Data: string): Promise<void> {
    await database.write(async () => {
      await database.get<Message>('messages').create((msg) => {
        msg._raw.id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        msg.senderId = endpointId;
        msg.conversationId = 'spike-test';
        msg.type = 'text';
        msg.payload = base64Data;
        msg.ttl = 10;
        msg.status = 'received';
      });
    });
  }
}

export const meshTransport = new MeshTransport();

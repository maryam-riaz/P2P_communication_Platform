import type { DiscoveredPeer } from '../comms/ble/ble-types';
// We assume there's an event bus, but if not we can just use a simple callback registry or stub it out
// For now, we'll implement a simple EventEmitter-like pattern inline if EventBus is not available
import { DeviceEventEmitter } from 'react-native';

class PeerRegistryImpl {
  private peers = new Map<string, DiscoveredPeer>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  upsert(peer: DiscoveredPeer): void {
    const existing = this.peers.get(peer.id);
    this.peers.set(peer.id, { ...peer, last_seen: Date.now() });

    if (!existing) {
      console.log(`[PeerRegistry] New peer discovered: ${peer.id.slice(0, 8)}`);
      DeviceEventEmitter.emit('peer:discovered', peer);
      // Trigger handshake
      // HandshakeManager.initiateHandshake(peer);
    } else {
      this.peers.set(peer.id, { ...existing, last_seen: Date.now() });
    }
  }

  getAllPeers(): DiscoveredPeer[] {
    return Array.from(this.peers.values());
  }

  getPeer(id: string): DiscoveredPeer | undefined {
    return this.peers.get(id);
  }

  removePeer(id: string): void {
    this.peers.delete(id);
    DeviceEventEmitter.emit('peer:lost', id);
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const TIMEOUT_MS = 45_000; // 45 seconds

      for (const [id, peer] of this.peers) {
        if (now - peer.last_seen > TIMEOUT_MS) {
          console.log(`[PeerRegistry] Peer timeout: ${id.slice(0, 8)}`);
          this.removePeer(id);
        }
      }
    }, 15_000); // Check every 15 seconds
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  clear(): void {
    this.peers.clear();
    this.stopHeartbeat();
  }
}

export const PeerRegistry = new PeerRegistryImpl();

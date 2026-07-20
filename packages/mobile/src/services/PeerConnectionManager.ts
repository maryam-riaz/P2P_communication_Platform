import { DiscoveredPeer } from '../comms/ble/ble-types';
import { SecureTransport } from '../comms/secure-transport';
import { ChatService } from './ChatService';
import { PeerRegistry } from './PeerRegistry';
import { AndroidWifiP2PTransport, WifiDirectPeer } from '../comms/wifi-direct/wifi-p2p-transport.android';

export type ConnectionState = 
  | { status: 'discovered'; timestamp: number }
  | { status: 'handshake_initiated'; timestamp: number; attempt: number; abortController: AbortController }
  | { status: 'handshake_complete'; timestamp: number; secureTransport: SecureTransport }
  | { status: 'connected'; timestamp: number; secureTransport: SecureTransport; lastActivity: number }
  | { status: 'lost'; timestamp: number; gracePeriodTimer: ReturnType<typeof setTimeout> }
  | { status: 'cleaning_up'; timestamp: number }
  | { status: 'idle' };

interface PeerConnectionManagerDeps {
  wifiDirectTransport: typeof AndroidWifiP2PTransport;
  secureTransportFactory: (raw: AndroidWifiP2PTransport, localDeviceId: string) => SecureTransport;
  chatService: ChatService;
  localDeviceId: string;
  localPrivateKey: string;
  localPublicKey: string;
  localDisplayName: string;
  peerRegistry: typeof PeerRegistry;
  waitConnectionInfo: () => Promise<{ groupOwnerAddress: string; isGroupOwner: boolean }>;
  onInboundHandshakeReady?: (deviceId: string) => void;
}

export class PeerConnectionManager {
  private peerStates = new Map<string, ConnectionState>();
  private stateListeners = new Map<string, Set<(state: ConnectionState) => void>>();
  private unsubPeerDiscovered: (() => void) | null = null;
  private unsubPeerLost: (() => void) | null = null;
  private unsubPeersChanged: (() => void) | null = null;
  private currentWifiPeers: WifiDirectPeer[] = [];
  private bleDiscoveredIds = new Map<string, string>(); // compoundKey → deviceId
  private handshakeFailureTimestamps = new Map<string, number>(); // deviceId → timestamp of last failure
  private messageHandler: ((peerId: string, message: string) => void) | null = null;
  private deps: PeerConnectionManagerDeps | null = null;
  private started = false;

  constructor(deps: PeerConnectionManagerDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const { peerRegistry, wifiDirectTransport } = this.deps!;

    this.unsubPeerDiscovered = peerRegistry.onPeerDiscovered((peer) => {
      this.handlePeerDiscovered(peer);
    });

    this.unsubPeerLost = peerRegistry.onPeerLost((deviceId) => {
      this.handlePeerLost(deviceId);
    });

    this.unsubPeersChanged = wifiDirectTransport.onPeersChanged((peers) => {
      this.currentWifiPeers = peers;
    });

    this.started = true;
    console.log('[PeerConnectionManager] Started');
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    this.unsubPeerDiscovered?.();
    this.unsubPeerLost?.();
    this.unsubPeersChanged?.();
    this.unsubPeerDiscovered = null;
    this.unsubPeerLost = null;
    this.unsubPeersChanged = null;

    for (const deviceId of this.peerStates.keys()) {
      await this.teardownConnection(deviceId);
    }
    this.peerStates.clear();
    this.stateListeners.clear();
    this.currentWifiPeers = [];
    this.started = false;
    console.log('[PeerConnectionManager] Stopped');
  }

  async destroy(): Promise<void> {
    await this.stop();
  }

  private setState(deviceId: string, state: ConnectionState): void {
    this.peerStates.set(deviceId, state);
    const listeners = this.stateListeners.get(deviceId);
    if (listeners) {
      listeners.forEach(cb => cb(state));
    }
  }

  getConnectionState(deviceId: string): ConnectionState | undefined {
    return this.peerStates.get(deviceId);
  }

  onStateChange(deviceId: string, callback: (state: ConnectionState) => void): () => void {
    if (!this.stateListeners.has(deviceId)) {
      this.stateListeners.set(deviceId, new Set());
    }
    this.stateListeners.get(deviceId)!.add(callback);
    return () => {
      this.stateListeners.get(deviceId)?.delete(callback);
    };
  }

  async initiateHandshake(deviceId: string): Promise<void> {
    const currentState = this.peerStates.get(deviceId);
    if (currentState && (currentState.status === 'handshake_initiated' || currentState.status === 'handshake_complete' || currentState.status === 'connected')) {
      console.log(`[PeerConnectionManager] Peer ${deviceId.slice(0, 8)} already in handshake/connected, skipping`);
      return;
    }

    const peer = this.deps!.peerRegistry.getPeer(deviceId);
    if (!peer) {
      console.warn(`[PeerConnectionManager] Peer ${deviceId.slice(0, 8)} not in registry, cannot initiate handshake`);
      return;
    }

    const abortController = new AbortController();
    this.setState(deviceId, { status: 'handshake_initiated', timestamp: Date.now(), attempt: 1, abortController });

    // 30s timeout for entire handshake
    const timeoutId = setTimeout(() => {
      if (this.peerStates.get(deviceId)?.status === 'handshake_initiated') {
        abortController.abort();
      }
    }, 30000);

    try {
      const macAddress = await this.resolveMacAddress(deviceId);
      if (!macAddress) {
        throw new Error(`Could not resolve MAC address for deviceId ${deviceId.slice(0, 8)}`);
      }

      console.log(`[PeerConnectionManager] Initiating WiFi Direct connection to ${deviceId.slice(0, 8)} (MAC: ${macAddress})`);
      await this.deps!.wifiDirectTransport.connectToPeer(macAddress);

      // Wait for event-driven onConnectionInfo (not raw polling)
      const connectionInfo = await this.deps!.waitConnectionInfo();
      if (!connectionInfo.groupOwnerAddress) {
        throw new Error('WiFi Direct group not formed or no group owner address');
      }

      // Don't proceed if we're the group owner (GO handles inbound connections separately)
      if (connectionInfo.isGroupOwner) {
        console.log(`[PeerConnectionManager] Peer ${deviceId.slice(0, 8)}: I am Group Owner, skipping outbound connect`);
        this.setState(deviceId, { status: 'idle' });
        return;
      }

      const rawTransport = new AndroidWifiP2PTransport(this.deps!.localDeviceId);
      await rawTransport.connectToSocket(connectionInfo.groupOwnerAddress, 8888);

      const secureTransport = this.deps!.secureTransportFactory(rawTransport, this.deps!.localDeviceId);

      // Register receive handler for messages
      secureTransport.receive((plaintext) => {
        if (this.messageHandler) {
          this.messageHandler(deviceId, plaintext);
        }
      });

      // Set up handshake ready callback before establishing
      secureTransport.onHandshakeReady(() => {
        const remoteId = secureTransport.getRemoteDeviceId();
        if (remoteId) {
          console.log(`[PeerConnectionManager] Handshake completed for peer ${remoteId.slice(0, 8)}`);
          this.setState(deviceId, { status: 'connected', timestamp: Date.now(), secureTransport, lastActivity: Date.now() });
        }
      });

      await secureTransport.establishHandshake();

      this.deps!.chatService.registerSecureTransport(secureTransport);
      this.deps!.chatService.registerActiveTransport(deviceId, secureTransport);

      // If handshake didn't transition via callback, force it
      const postState = this.peerStates.get(deviceId);
      if (postState && postState.status === 'handshake_initiated') {
        this.setState(deviceId, { status: 'connected', timestamp: Date.now(), secureTransport, lastActivity: Date.now() });
      }

      this.handshakeFailureTimestamps.delete(deviceId);
      console.log(`[PeerConnectionManager] Handshake completed for peer ${deviceId.slice(0, 8)}`);

    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn(`[PeerConnectionManager] Handshake timed out for peer ${deviceId.slice(0, 8)}`);
      } else {
        console.warn(`[PeerConnectionManager] Handshake failed for peer ${deviceId.slice(0, 8)}:`, error);
      }
      this.handshakeFailureTimestamps.set(deviceId, Date.now());
      await this.handleHandshakeFailure(deviceId, error as Error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async handleHandshakeFailure(deviceId: string, error: Error): Promise<void> {
    const currentState = this.peerStates.get(deviceId);
    if (!currentState || currentState.status !== 'handshake_initiated') return;

    const attempt = currentState.attempt;
    if (attempt >= 5) {
      console.log(`[PeerConnectionManager] Max retries reached for peer ${deviceId.slice(0, 8)}, cleaning up`);
      await this.teardownConnection(deviceId);
      return;
    }

    const backoffDelays = [200, 400, 800, 1600, 3200];
    const delay = backoffDelays[attempt - 1] || 3200;

    console.log(`[PeerConnectionManager] Retrying handshake for peer ${deviceId.slice(0, 8)} in ${delay}ms (attempt ${attempt + 1})`);
    
    this.setState(deviceId, { 
      status: 'handshake_initiated', 
      timestamp: Date.now(), 
      attempt: attempt + 1, 
      abortController: new AbortController() 
    });

    setTimeout(() => {
      if (this.peerStates.get(deviceId)?.status === 'handshake_initiated') {
        this.initiateHandshake(deviceId).catch(() => {});
      }
    }, delay);
  }

  private async resolveMacAddress(deviceId: string): Promise<string | null> {
    const peer = this.deps!.peerRegistry.getPeer(deviceId);
    if (!peer) return null;

    // Try existing WiFi Direct peers by name match
    for (const wifiPeer of this.currentWifiPeers) {
      if (wifiPeer.deviceName.toLowerCase() === (peer.name || '').toLowerCase() ||
          wifiPeer.deviceAddress.toLowerCase() === deviceId.toLowerCase()) {
        return wifiPeer.deviceAddress;
      }
    }

    // Try compound-key BLE map for name-based lookup
    if (peer.name) {
      const firstWord = peer.name.split(/['\s]/)[0].toLowerCase();
      const idPrefix = peer.id.substring(0, 8).toLowerCase();
      const compoundKey = `${firstWord}:${idPrefix}`;
      if (this.bleDiscoveredIds.has(compoundKey)) {
        // Use WiFi Direct discovery to find MAC for the resolved peer
        const peers = await this.deps!.wifiDirectTransport.rediscoverAndWait(2000);
        for (const wifiPeer of peers) {
          if (wifiPeer.deviceName.toLowerCase() === (peer.name || '').toLowerCase()) {
            return wifiPeer.deviceAddress;
          }
        }
      }
    }

    // Fallback: trigger fresh discovery and try again
    const peers = await this.deps!.wifiDirectTransport.rediscoverAndWait(2000);
    for (const wifiPeer of peers) {
      if (wifiPeer.deviceName.toLowerCase() === (peer.name || '').toLowerCase() ||
          wifiPeer.deviceAddress.toLowerCase() === deviceId.toLowerCase()) {
        return wifiPeer.deviceAddress;
      }
    }

    return null;
  }

  private handlePeerDiscovered(peer: DiscoveredPeer): void {
    const currentState = this.peerStates.get(peer.id);
    if (currentState && (currentState.status === 'connected' || currentState.status === 'handshake_initiated' || currentState.status === 'handshake_complete')) {
      return;
    }

    // Update BLE compound-key map for MAC resolution
    if (peer.name) {
      const firstWord = peer.name.split(/['\s]/)[0].toLowerCase();
      const idPrefix = peer.id.substring(0, 8).toLowerCase();
      const compoundKey = `${firstWord}:${idPrefix}`;
      this.bleDiscoveredIds.set(compoundKey, peer.id);
    }

    if (currentState && currentState.status === 'lost') {
      clearTimeout(currentState.gracePeriodTimer);
      console.log(`[PeerConnectionManager] Peer ${peer.id.slice(0, 8)} rediscovered during grace period, canceling cleanup`);
    }

    // Fast-reconnect debounce: if last handshake failed <5s ago, skip (avoid rapid-fire)
    const lastFailure = this.handshakeFailureTimestamps.get(peer.id);
    if (lastFailure && Date.now() - lastFailure < 5000) {
      console.log(`[PeerConnectionManager] Peer ${peer.id.slice(0, 8)} recently failed, debouncing reconnect`);
      return;
    }

    this.setState(peer.id, { status: 'discovered', timestamp: Date.now() });
    this.initiateHandshake(peer.id).catch(err => {
      console.warn(`[PeerConnectionManager] Failed to initiate handshake for peer ${peer.id.slice(0, 8)}:`, err);
    });
  }

  private handlePeerLost(deviceId: string): void {
    const currentState = this.peerStates.get(deviceId);
    if (!currentState || currentState.status === 'idle') {
      return;
    }

    // Clean up BLE compound-key entries for this deviceId
    for (const [key, id] of this.bleDiscoveredIds.entries()) {
      if (id === deviceId) {
        this.bleDiscoveredIds.delete(key);
      }
    }

    if (currentState.status === 'connected') {
      const gracePeriodTimer = setTimeout(() => {
        this.setState(deviceId, { status: 'cleaning_up', timestamp: Date.now() });
        this.teardownConnection(deviceId).catch(() => {});
      }, 3000);

      this.setState(deviceId, { status: 'lost', timestamp: Date.now(), gracePeriodTimer });
      console.log(`[PeerConnectionManager] Peer ${deviceId.slice(0, 8)} lost, starting 3s grace period`);
    } else if (currentState.status === 'handshake_initiated') {
      currentState.abortController.abort();
      this.teardownConnection(deviceId).catch(() => {});
    } else {
      this.teardownConnection(deviceId).catch(() => {});
    }
  }

  async teardownConnection(deviceId: string): Promise<void> {
    const currentState = this.peerStates.get(deviceId);
    if (!currentState || currentState.status === 'idle' || currentState.status === 'cleaning_up') {
      return;
    }

    if (currentState.status === 'lost') {
      const lostState = currentState as { status: 'lost'; gracePeriodTimer: ReturnType<typeof setTimeout>; timestamp: number };
      clearTimeout(lostState.gracePeriodTimer);
    }

    if (currentState.status === 'handshake_initiated') {
      currentState.abortController.abort();
    }

    if (currentState.status === 'handshake_complete' || currentState.status === 'connected') {
      const connectedState = currentState as { status: 'connected' | 'handshake_complete'; secureTransport: SecureTransport };
      try {
        await connectedState.secureTransport.disconnect();
        this.deps!.chatService.unregisterActiveTransport(deviceId);
        this.deps!.chatService.unregisterSecureTransport(connectedState.secureTransport);
        console.log(`[PeerConnectionManager] Disconnected secure transport for peer ${deviceId.slice(0, 8)}`);
      } catch (err) {
        console.warn(`[PeerConnectionManager] Error disconnecting transport for peer ${deviceId.slice(0, 8)}:`, err);
      }
    }

    this.setState(deviceId, { status: 'idle' });
  }

  async reconcile(): Promise<void> {
    const { peerRegistry } = this.deps!;
    const peers = peerRegistry.getAllPeers();
    
    for (const peer of peers) {
      const state = this.peerStates.get(peer.id);
      if (!state || state.status === 'idle' || state.status === 'lost') {
        console.log(`[PeerConnectionManager] Reconciling peer ${peer.id.slice(0, 8)}, initiating handshake`);
        await this.initiateHandshake(peer.id);
      }
    }
  }

  setMessageHandler(handler: (peerId: string, message: string) => void): void {
    this.messageHandler = handler;
  }

  getActiveTransport(deviceId: string): SecureTransport | null {
    const state = this.peerStates.get(deviceId);
    if (state && (state.status === 'connected' || state.status === 'handshake_complete')) {
      return (state as { status: 'connected' | 'handshake_complete'; secureTransport: SecureTransport }).secureTransport;
    }
    return null;
  }
}

export default PeerConnectionManager;
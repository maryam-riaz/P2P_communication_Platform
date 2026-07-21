import { Platform } from 'react-native';
import { nearbyConnections, requestNearbyPermissions } from './NearbyConnections';
import { logm, warnm, errm } from '../utils/logger';
import type {
  PeerInfo,
  PeerFoundEvent,
  PeerLostEvent,
  PeerConnectedEvent,
  PeerDisconnectedEvent,
  PayloadReceivedEvent,
  PayloadProgressEvent,
  ReconnectingEvent,
  AdvertiseOptions,
  ITransport,
} from './types';
import {
  PeerState,
  SERVICE_ID_DEFAULT,
  CONNECT_TIMEOUT_MS,
} from './types';

const M = 'MESH';
const N = 'NATIVE';

type EventHandler = (...args: any[]) => void;

class MeshTransport implements ITransport {
  private peers = new Map<string, PeerInfo>();
  private eventListeners = new Map<string, Set<EventHandler>>();
  private unsubscribeFns: (() => void)[] = [];
  private connectTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private isAdvertising_ = false;
  private isDiscovering_ = false;
  private serviceId = SERVICE_ID_DEFAULT;
  private platformEventsSubscribed = false;

  get isAdvertising(): boolean {
    return this.isAdvertising_;
  }

  get isDiscovering(): boolean {
    return this.isDiscovering_;
  }

  private emit(event: string, ...args: any[]) {
    this.eventListeners.get(event)?.forEach((fn) => fn(...args));
  }

  private on(event: string, handler: EventHandler): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(handler);
    return () => this.eventListeners.get(event)?.delete(handler);
  }

  // ─── ITransport Implementation ────────────────────────────────────────────

  async advertise(options?: AdvertiseOptions): Promise<void> {
    logm(M, '=== advertise() called ===');
    logm(M, `Platform.OS = "${Platform.OS}"`);

    if (Platform.OS !== 'android') {
      errm(M, 'iOS transport not yet available');
      throw new Error('iOS transport not yet available on this device');
    }

    logm(M, 'Platform check OK, requesting permissions...');
    const ok = await requestNearbyPermissions();
    logm(M, `Permissions result: ${ok}`);
    if (!ok) {
      errm(M, 'Permissions denied by user');
      throw new Error('Permissions denied');
    }

    const sid = options?.serviceId || this.serviceId;
    const name = options?.deviceName || '';
    logm(M, `Calling native startAdvertising(serviceId="${sid}", deviceName="${name}")`);

    if (!nearbyConnections) {
      errm(M, 'nearbyConnections is null — native module not available');
      throw new Error('Native NearbyConnections module not available');
    }

    await nearbyConnections.startAdvertising(sid, name);
    this.isAdvertising_ = true;
    this.serviceId = sid;

    logm(M, 'Subscribing to platform events (advertise)...');
    this.subscribeToPlatformEvents();

    logm(M, `advertise() succeeded, isAdvertising=${this.isAdvertising_}`);
  }

  async discover(serviceId?: string): Promise<void> {
    logm(M, '=== discover() called ===');
    logm(M, `Platform.OS = "${Platform.OS}"`);

    if (Platform.OS !== 'android') {
      errm(M, 'iOS transport not yet available');
      throw new Error('iOS transport not yet available on this device');
    }

    logm(M, 'Platform check OK, requesting permissions...');
    const ok = await requestNearbyPermissions();
    logm(M, `Permissions result: ${ok}`);
    if (!ok) {
      errm(M, 'Permissions denied by user');
      throw new Error('Permissions denied');
    }

    const sid = serviceId || this.serviceId;
    logm(M, `Calling native startDiscovery(serviceId="${sid}")`);

    if (!nearbyConnections) {
      errm(M, 'nearbyConnections is null — native module not available');
      throw new Error('Native NearbyConnections module not available');
    }

    await nearbyConnections.startDiscovery(sid);
    this.isDiscovering_ = true;
    this.serviceId = sid;

    logm(M, 'Subscribing to platform events...');
    this.subscribeToPlatformEvents();

    logm(M, `discover() succeeded, isDiscovering=${this.isDiscovering_}`);
  }

  async connect(endpointId: string): Promise<void> {
    logm(M, `connect(endpointId="${endpointId}")`);
    const peer = this.peers.get(endpointId);
    if (!peer) {
      errm(M, `Peer ${endpointId} not found`);
      throw new Error(`Peer ${endpointId} not found`);
    }
    if (peer.state === PeerState.Connected) { logm(M, `Peer ${endpointId} already connected`); return; }
    if (peer.state === PeerState.Connecting) { logm(M, `Peer ${endpointId} already connecting`); return; }

    peer.state = PeerState.Connecting;
    this.emitPeerUpdate(peer);

    const timeout = setTimeout(() => {
      this.connectTimeouts.delete(endpointId);
      if (peer.state === PeerState.Connecting) {
        warnm(M, `Connect timeout for ${endpointId}`);
        peer.state = PeerState.Disconnected;
        this.emitPeerUpdate(peer);
        this.emit('peerDisconnected', { peerId: endpointId, unexpected: true });
      }
    }, CONNECT_TIMEOUT_MS);

    this.connectTimeouts.set(endpointId, timeout);

    try {
      await nearbyConnections!.connect(endpointId);
      clearTimeout(timeout);
      this.connectTimeouts.delete(endpointId);
      logm(M, `connect(${endpointId}) succeeded`);
    } catch (err: any) {
      clearTimeout(timeout);
      this.connectTimeouts.delete(endpointId);
      peer.state = PeerState.Disconnected;
      this.emitPeerUpdate(peer);
      errm(M, `connect(${endpointId}) failed`, err);
      throw err;
    }
  }

  async disconnect(endpointId: string): Promise<void> {
    logm(M, `disconnect(endpointId="${endpointId}")`);
    this.removePeer(endpointId);
    await nearbyConnections!.disconnectFromEndpoint(endpointId);
    logm(M, `disconnect(${endpointId}) succeeded`);
  }

  async sendPayload(endpointId: string, data: string): Promise<void> {
    const peer = this.peers.get(endpointId);
    if (!peer || peer.state !== PeerState.Connected) {
      throw new Error(`Peer ${endpointId} is not connected`);
    }
    await nearbyConnections!.sendPayload(endpointId, data);
  }

  async broadcast(data: string): Promise<void> {
    logm(M, `broadcast(data.length=${data.length})`);
    const connectedIds = await nearbyConnections!.getConnectedEndpoints();
    if (connectedIds.length === 0) {
      throw new Error('No peers connected. Discover and connect first.');
    }
    await nearbyConnections!.sendPayloadToAll(data);
    logm(M, 'broadcast succeeded');
  }

  async getConnectedPeers(): Promise<PeerInfo[]> {
    const connectedIds = await nearbyConnections!.getConnectedEndpoints();
    return connectedIds
      .map((id) => this.peers.get(id))
      .filter((p): p is PeerInfo => p !== undefined);
  }

  getAllPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  async getRSSI(endpointId: string): Promise<number | null> {
    try {
      return await nearbyConnections!.getRSSI(endpointId);
    } catch {
      return null;
    }
  }

  async stopAdvertising(): Promise<void> {
    logm(M, 'stopAdvertising()');
    await nearbyConnections!.stopAdvertising();
    this.isAdvertising_ = false;
    logm(M, 'stopAdvertising done');
  }

  async stopDiscovery(): Promise<void> {
    logm(M, 'stopDiscovery()');
    await nearbyConnections!.stopDiscovery();
    this.isDiscovering_ = false;
    this.peers.forEach((peer, id) => {
      if (peer.state === PeerState.Found) {
        this.peers.delete(id);
      }
    });
    logm(M, 'stopDiscovery done');
  }

  async stopAll(): Promise<void> {
    logm(M, '=== stopAll() ===');
    this.connectTimeouts.forEach((t) => clearTimeout(t));
    this.connectTimeouts.clear();
    this.unsubscribeFns.forEach((fn) => fn());
    this.unsubscribeFns = [];
    this.platformEventsSubscribed = false;
    this.peers.clear();
    this.isAdvertising_ = false;
    this.isDiscovering_ = false;

    await nearbyConnections!.stopAll();
    logm(M, 'stopAll complete');
  }

  // ─── Public Event Subscriptions (ITransport) ──────────────────────────────

  onPeerFound(handler: (event: PeerFoundEvent) => void): () => void {
    return this.on('peerFound', handler);
  }

  onPeerLost(handler: (event: PeerLostEvent) => void): () => void {
    return this.on('peerLost', handler);
  }

  onPeerConnected(handler: (event: PeerConnectedEvent) => void): () => void {
    return this.on('peerConnected', handler);
  }

  onPeerDisconnected(handler: (event: PeerDisconnectedEvent) => void): () => void {
    return this.on('peerDisconnected', handler);
  }

  onPayloadReceived(handler: (event: PayloadReceivedEvent) => void): () => void {
    return this.on('payloadReceived', handler);
  }

  onPayloadProgress(handler: (event: PayloadProgressEvent) => void): () => void {
    return this.on('payloadProgress', handler);
  }

  onReconnecting(handler: (event: ReconnectingEvent) => void): () => void {
    return this.on('reconnecting', handler);
  }

  // ─── Internal: Platform Event Wiring ──────────────────────────────────────

  private subscribeToPlatformEvents() {
    if (this.platformEventsSubscribed) {
      logm(M, 'subscribeToPlatformEvents: already subscribed, skipping');
      return;
    }
    this.platformEventsSubscribed = true;
    logm(M, 'subscribeToPlatformEvents: setting up native listeners');
    this.unsubscribeFns.push(
      nearbyConnections!.onEndpointFound((e) => {
        logm(M, `native event: onEndpointFound(endpointId="${e.endpointId}", name="${e.endpointName}")`);
        const existing = this.peers.get(e.endpointId);
        if (existing) {
          existing.displayName = e.endpointName;
          existing.lastSeen = Date.now();
          this.emitPeerUpdate(existing);
        } else {
          const peer: PeerInfo = {
            endpointId: e.endpointId,
            displayName: e.endpointName,
            state: PeerState.Found,
            lastSeen: Date.now(),
            rssi: null,
            reconnectAttempts: 0,
          };
          this.peers.set(e.endpointId, peer);
          this.emit('peerFound', { peerId: e.endpointId, displayName: e.endpointName, serviceId: e.serviceId });
        }
      }),

      nearbyConnections!.onEndpointLost((e) => {
        logm(M, `native event: onEndpointLost(endpointId="${e.endpointId}")`);
        const peer = this.peers.get(e.endpointId);
        if (peer) {
          peer.state = PeerState.Disconnected;
          this.emitPeerUpdate(peer);
        }
        this.emit('peerLost', { peerId: e.endpointId });
      }),

      nearbyConnections!.onEndpointConnected((e) => {
        logm(M, `native event: onEndpointConnected(endpointId="${e.endpointId}")`);
        clearTimeout(this.connectTimeouts.get(e.endpointId));
        this.connectTimeouts.delete(e.endpointId);

        let peer = this.peers.get(e.endpointId);
        if (!peer) {
          peer = {
            endpointId: e.endpointId,
            displayName: '',
            state: PeerState.Connected,
            lastSeen: Date.now(),
            rssi: null,
            reconnectAttempts: 0,
          };
          this.peers.set(e.endpointId, peer);
        } else {
          peer.state = PeerState.Connected;
          peer.reconnectAttempts = 0;
          peer.lastSeen = Date.now();
        }
        this.emitPeerUpdate(peer);
        this.emit('peerConnected', { peerId: e.endpointId });
      }),

      nearbyConnections!.onEndpointDisconnected((e) => {
        logm(M, `native event: onEndpointDisconnected(endpointId="${e.endpointId}", unexpected=${e.unexpected})`);
        let peer = this.peers.get(e.endpointId);
        if (!peer) {
          peer = {
            endpointId: e.endpointId,
            displayName: '',
            state: PeerState.Disconnected,
            lastSeen: Date.now(),
            rssi: null,
            reconnectAttempts: 0,
          };
          this.peers.set(e.endpointId, peer);
        } else {
          peer.state = PeerState.Disconnected;
          peer.lastSeen = Date.now();
        }
        this.emitPeerUpdate(peer);
        this.emit('peerDisconnected', { peerId: e.endpointId, unexpected: e.unexpected ?? false });
      }),

      nearbyConnections!.onPayloadReceived((e) => {
        logm(M, `native event: onPayloadReceived(endpointId="${e.endpointId}", data.length=${e.data?.length})`);
        this.emit('payloadReceived', { peerId: e.endpointId, data: e.data });
      }),

      nearbyConnections!.onPayloadProgress((e) => {
        this.emit('payloadProgress', {
          peerId: e.endpointId,
          payloadId: e.payloadId,
          bytesTransferred: e.bytesTransferred,
          totalBytes: e.totalBytes,
          status: e.status,
        });
      }),

      nearbyConnections!.onReconnecting((e) => {
        warnm(M, `native event: onReconnecting(endpointId="${e.endpointId}", attempt=${e.attempt}/${e.maxAttempts})`);
        const peer = this.peers.get(e.endpointId);
        if (peer) {
          peer.state = PeerState.Reconnecting;
          peer.reconnectAttempts = e.attempt;
          this.emitPeerUpdate(peer);
        }
        this.emit('reconnecting', {
          peerId: e.endpointId,
          attempt: e.attempt,
          maxAttempts: e.maxAttempts,
        });
      }),

      nearbyConnections!.onReconnectionFailed((e) => {
        warnm(M, `native event: onReconnectionFailed(endpointId="${e.endpointId}")`);
        const peer = this.peers.get(e.endpointId);
        if (peer) {
          peer.state = PeerState.Disconnected;
          this.emitPeerUpdate(peer);
        }
        this.emit('peerDisconnected', { peerId: e.endpointId, unexpected: true });
      }),
    );
    logm(M, 'subscribeToPlatformEvents: all listeners registered');
  }

  private emitPeerUpdate(peer: PeerInfo) {
    this.peers.set(peer.endpointId, peer);
  }

  private removePeer(endpointId: string) {
    clearTimeout(this.connectTimeouts.get(endpointId));
    this.connectTimeouts.delete(endpointId);
    this.peers.delete(endpointId);
  }
}

export const meshTransport = new MeshTransport();

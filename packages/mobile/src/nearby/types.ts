export enum PeerState {
  Found = 'found',
  Connecting = 'connecting',
  Connected = 'connected',
  Disconnecting = 'disconnecting',
  Disconnected = 'disconnected',
  Reconnecting = 'reconnecting',
}

export interface PeerInfo {
  endpointId: string;
  displayName: string;
  state: PeerState;
  lastSeen: number;
  rssi: number | null;
  reconnectAttempts: number;
}

export interface PeerFoundEvent {
  peerId: string;
  displayName: string;
  serviceId?: string;
}

export interface PeerLostEvent {
  peerId: string;
}

export interface PeerConnectedEvent {
  peerId: string;
}

export interface PeerDisconnectedEvent {
  peerId: string;
  unexpected: boolean;
}

export interface PayloadReceivedEvent {
  peerId: string;
  data: string;
}

export interface PayloadProgressEvent {
  peerId: string;
  payloadId: string;
  bytesTransferred: number;
  totalBytes: number;
  status: 'in_progress' | 'success' | 'failure';
}

export interface ReconnectingEvent {
  peerId: string;
  attempt: number;
  maxAttempts: number;
}

export interface AdvertiseOptions {
  deviceName?: string;
  serviceId?: string;
}

export interface ITransport {
  advertise(options?: AdvertiseOptions): Promise<void>;
  discover(serviceId?: string): Promise<void>;
  connect(endpointId: string): Promise<void>;
  disconnect(endpointId: string): Promise<void>;
  sendPayload(endpointId: string, data: string): Promise<void>;
  broadcast(data: string): Promise<void>;
  getConnectedPeers(): Promise<PeerInfo[]>;
  getAllPeers(): PeerInfo[];
  getRSSI(endpointId: string): Promise<number | null>;
  stopAdvertising(): Promise<void>;
  stopDiscovery(): Promise<void>;
  stopAll(): Promise<void>;

  onPeerFound(handler: (event: PeerFoundEvent) => void): () => void;
  onPeerLost(handler: (event: PeerLostEvent) => void): () => void;
  onPeerConnected(handler: (event: PeerConnectedEvent) => void): () => void;
  onPeerDisconnected(handler: (event: PeerDisconnectedEvent) => void): () => void;
  onPayloadReceived(handler: (event: PayloadReceivedEvent) => void): () => void;
  onPayloadProgress(handler: (event: PayloadProgressEvent) => void): () => void;
  onReconnecting(handler: (event: ReconnectingEvent) => void): () => void;
}

export const SERVICE_ID_DEFAULT = 'com.mojojojoo.sosifyapp.p2p';

export const CONNECT_TIMEOUT_MS = 15_000;
export const RECONNECT_MAX_ATTEMPTS = 5;
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 60_000;

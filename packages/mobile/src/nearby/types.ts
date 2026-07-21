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

// ─── Phase 2: Envelope & Routing Types ───────────────────────────────────────

export type EnvelopeType =
  | 'TEXT'
  | 'IMAGE'
  | 'VIDEO_CHUNK'
  | 'AUDIO'
  | 'SOS'
  | 'ROLE_CREDENTIAL'
  | 'CHATBOT';

export interface MeshEnvelope {
  message_id: string;
  type: EnvelopeType;
  sender_id: string;
  sender_role_cert: string;
  sender_public_key: string;
  conversation_id: string;
  display_name: string;
  ttl: number;
  timestamp: number;
  chunk_index: number;
  chunk_total: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  route_history: string[];
}

export enum PeerSecurityState {
  Unknown = 'unknown',
  Trusted = 'trusted',
  Mismatch = 'mismatch',
  Pending = 'pending',
}

export interface PendingOutboxEntry {
  message_id: string;
  envelope_json: string;
  type: EnvelopeType;
  target_peer_id?: string;
  ttl_at_queue: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

export const PER_TYPE_TTL: Record<EnvelopeType, number> = {
  TEXT: 5,
  IMAGE: 4,
  VIDEO_CHUNK: 3,
  AUDIO: 4,
  SOS: 7,
  ROLE_CREDENTIAL: 2,
  CHATBOT: 3,
};

export const DEDUP_CACHE_MAX = 1000;
export const DEDUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

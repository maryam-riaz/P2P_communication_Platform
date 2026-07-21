import { Q } from '@nozbe/watermelondb';
import type {
  ITransport,
  MeshEnvelope,
  EnvelopeType,
  PayloadReceivedEvent,
  PeerConnectedEvent,
} from '../nearby/types';
import { createEnvelope, serializeEnvelope, deserializeEnvelope } from './MessageEnvelope';
import { DedupCache } from './DedupCache';
import { keyManager, keyExchange, encryptForPeer, decryptFromPeer } from '../crypto';
import { database } from '../db';
import { Message, PendingMessage, PeerKey } from '../db/models';
import { logm, errm } from '../utils/logger';
import { receiveChunk } from './ChunkAssembler';
import { ConversationManager } from './ConversationManager';

const TAG = 'ROUTER';

export interface PeerSession {
  fingerprint: string;
  endpointId: string;
  displayName: string;
  connectedAt: number;
}

export class MessageRouter {
  private transport: ITransport;
  private dedup: DedupCache;
  private deviceId: string;
  private displayName = '';
  private keyManagerInitialized = false;
  private unsubscribers: (() => void)[] = [];
  private decryptedCallbacks = new Set<(senderId: string, plaintext: string, conversationId?: string) => void>();
  private conversationManager: ConversationManager;
  peerNames = new Map<string, string>();
  private peerSessions = new Map<string, PeerSession>();
  private endpointToFingerprint = new Map<string, string>();
  private staleEndpointToFingerprint = new Map<string, string>();
  private sessionSubscribers = new Set<(session: PeerSession) => void>();

  getDeviceId(): string {
    return this.deviceId;
  }

  getDedupSize(): number {
    return this.dedup.size();
  }

  constructor(transport: ITransport, deviceId?: string) {
    this.transport = transport;
    this.dedup = new DedupCache();
    this.deviceId = deviceId || 'unknown-device';
    this.conversationManager = new ConversationManager(this.deviceId);
    this.wireEvents();
  }

  setDisplayName(name: string): void {
    this.displayName = name;
  }

  getDisplayName(): string {
    return this.displayName;
  }

  setDeviceId(id: string): void {
    this.deviceId = id;
    this.conversationManager.setSelfId(id);
  }

  getPeerName(peerId: string): string {
    return this.peerNames.get(peerId)
      || this.peerSessions.get(peerId)?.displayName
      || '';
  }

  subscribePeerSession(cb: (session: PeerSession) => void): () => void {
    this.peerSessions.forEach((session) => cb(session));
    this.sessionSubscribers.add(cb);
    return () => this.sessionSubscribers.delete(cb);
  }

  getPeerSession(fingerprint: string): PeerSession | undefined {
    return this.peerSessions.get(fingerprint);
  }

  getPeerSessionByEndpoint(endpointId: string): PeerSession | undefined {
    const fingerprint = this.endpointToFingerprint.get(endpointId);
    if (fingerprint) return this.peerSessions.get(fingerprint);
    return undefined;
  }

  resolveEndpointId(endpointIdOrFingerprint: string): string {
    if (this.endpointToFingerprint.has(endpointIdOrFingerprint)) {
      return endpointIdOrFingerprint;
    }
    const session = this.peerSessions.get(endpointIdOrFingerprint);
    if (session?.endpointId) {
      return session.endpointId;
    }
    const staleFingerprint = this.staleEndpointToFingerprint.get(endpointIdOrFingerprint);
    if (staleFingerprint) {
      const currentSession = this.peerSessions.get(staleFingerprint);
      if (currentSession?.endpointId) {
        return currentSession.endpointId;
      }
    }
    return endpointIdOrFingerprint;
  }

  async ensureConversation(conversationId: string, peerId: string, peerName: string): Promise<void> {
    await this.conversationManager.getOrCreateConversation(conversationId, peerId, peerName);
  }

  async lookupConversationByPeer(peerId: string): Promise<string | null> {
    return this.conversationManager.lookupConversationByPeer(peerId);
  }

  async updateConversationPreview(conversationId: string, preview: string, messageType: string): Promise<void> {
    await this.conversationManager.updateLastMessage(conversationId, preview, messageType);
  }

  async ensureCrypto(): Promise<void> {
    if (!this.keyManagerInitialized) {
      await keyManager.initialize();
      this.keyManagerInitialized = true;
      this.deviceId = keyManager.getFingerprint();
      this.conversationManager.setSelfId(this.deviceId);
      logm(TAG, `KeyManager initialized. DeviceId=${this.deviceId.substring(0, 16)}...`);
    }
  }

  async sendMessage(
    type: EnvelopeType,
    plaintext: string,
    opts?: {
      senderRoleCert?: string;
      ttl?: number;
      chunkIndex?: number;
      chunkTotal?: number;
      conversationId?: string;
    },
  ): Promise<MeshEnvelope[]> {
    await this.ensureCrypto();
    const connectedPeers = await this.transport.getConnectedPeers();
    const envelopes: MeshEnvelope[] = [];

    if (connectedPeers.length === 0) {
      const env = createEnvelope(
        type,
        this.deviceId,
        keyManager.getPublicKeyB64(),
        opts?.senderRoleCert || '',
        btoa(plaintext),
        '',
        '',
        {
          ttl: opts?.ttl,
          chunkIndex: opts?.chunkIndex,
          chunkTotal: opts?.chunkTotal,
          conversationId: opts?.conversationId,
          displayName: this.displayName,
        },
      );
      this.dedup.add(env.message_id);
      envelopes.push(env);
      await this.persistMessage(env, 'pending', plaintext);
      await this.persistPending(env);
      logm(TAG, `sendMessage: no peers, queued ${env.message_id} (${type})`);
      return envelopes;
    }

    for (const peer of connectedPeers) {
      const theirPub = keyExchange.getPublicKey(peer.endpointId);
      if (theirPub) {
        const encrypted = encryptForPeer(plaintext, theirPub, keyManager.getKeypair().secretKey);
        const env = createEnvelope(
          type,
          this.deviceId,
          keyManager.getPublicKeyB64(),
          opts?.senderRoleCert || '',
          encrypted.ciphertext,
          encrypted.nonce,
          '',
          {
            ttl: opts?.ttl,
            chunkIndex: opts?.chunkIndex,
            chunkTotal: opts?.chunkTotal,
            conversationId: opts?.conversationId,
            displayName: this.displayName,
          },
        );
        this.dedup.add(env.message_id);
        envelopes.push(env);
        const serialized = serializeEnvelope(env);
        try {
          await this.transport.sendPayload(peer.endpointId, serialized);
          logm(TAG, `sendMessage: sent ${env.message_id} to ${peer.endpointId} (${type})`);
        } catch {
          logm(TAG, `sendMessage: failed to ${peer.endpointId}, queued ${env.message_id}`);
          await this.persistPending(env, peer.endpointId);
        }
      } else {
        logm(TAG, `sendMessage: no key for ${peer.endpointId}, sending unencrypted`);
        const env = createEnvelope(
          type,
          this.deviceId,
          keyManager.getPublicKeyB64(),
          opts?.senderRoleCert || '',
          btoa(plaintext),
          '',
          '',
          {
            ttl: opts?.ttl,
            chunkIndex: opts?.chunkIndex,
            chunkTotal: opts?.chunkTotal,
            conversationId: opts?.conversationId,
            displayName: this.displayName,
          },
        );
        this.dedup.add(env.message_id);
        envelopes.push(env);
        const serialized = serializeEnvelope(env);
        try {
          await this.transport.sendPayload(peer.endpointId, serialized);
        } catch {
          await this.persistPending(env, peer.endpointId);
        }
      }
    }

    for (const env of envelopes) {
      const recordId = await this.persistMessage(env, 'pending', plaintext);
      if (recordId) {
        await this.updateMessageStatus(recordId, 'sent');
      }
    }

    return envelopes;
  }

  async markConversationRead(conversationId: string, peerId: string): Promise<void> {
    await this.conversationManager.markRead(conversationId, peerId);
  }

  async sendToPeer(
    endpointIdOrFingerprint: string,
    type: EnvelopeType,
    plaintext: string,
    opts?: {
      senderRoleCert?: string;
      ttl?: number;
      chunkIndex?: number;
      chunkTotal?: number;
      conversationId?: string;
      messageId?: string;
    },
  ): Promise<MeshEnvelope> {
    await this.ensureCrypto();

    const endpointId = this.resolveEndpointId(endpointIdOrFingerprint);

    const theirPub = keyExchange.getPublicKey(endpointId);

    let ciphertext: string;
    let nonce: string;

    if (theirPub) {
      const encrypted = encryptForPeer(plaintext, theirPub, keyManager.getKeypair().secretKey);
      ciphertext = encrypted.ciphertext;
      nonce = encrypted.nonce;
    } else {
      ciphertext = btoa(plaintext);
      nonce = '';
    }

    const env = createEnvelope(
      type,
      this.deviceId,
      keyManager.getPublicKeyB64(),
      opts?.senderRoleCert || '',
      ciphertext,
      nonce,
      '',
      {
        messageId: opts?.messageId,
        ttl: opts?.ttl,
        chunkIndex: opts?.chunkIndex,
        chunkTotal: opts?.chunkTotal,
        conversationId: opts?.conversationId,
        displayName: this.displayName,
      },
    );

    // Use composite dedup key for IMAGE chunks (message_id + chunk_index) so relayed copies are rejected
    const dedupKey = type === 'IMAGE'
      ? `${env.message_id}_${opts?.chunkIndex ?? 0}`
      : env.message_id;
    this.dedup.add(dedupKey);
    const serialized = serializeEnvelope(env);

    // For IMAGE chunks, skip persistMessage (ImageSender handles sender-side record)
    let pendingRecordId: string | null = null;
    if (type !== 'IMAGE') {
      pendingRecordId = await this.persistMessage(env, 'pending', plaintext);
    }

    try {
      await this.transport.sendPayload(endpointId, serialized);
      logm(TAG, `sendToPeer: sent ${env.message_id} to ${endpointId}`);
    } catch {
      logm(TAG, `sendToPeer: failed to ${endpointId}, queued ${env.message_id}`);
      if (type !== 'IMAGE') {
        await this.persistPending(env, endpointId);
      }
      return env;
    }

    if (pendingRecordId) {
      await this.updateMessageStatus(pendingRecordId, 'sent');
    }

    return env;
  }

  destroy(): void {
    this.unsubscribers.forEach((fn) => fn());
    this.unsubscribers = [];
    this.dedup.destroy();
    this.decryptedCallbacks.clear();
    logm(TAG, 'MessageRouter destroyed');
  }

  subscribeDecrypted(cb: (senderId: string, plaintext: string, conversationId?: string) => void): () => void {
    this.decryptedCallbacks.add(cb);
    return () => this.decryptedCallbacks.delete(cb);
  }

  private wireEvents(): void {
    this.unsubscribers.push(
      this.transport.onPayloadReceived((event) => {
        this.handlePayloadReceived(event).catch((err) =>
          errm(TAG, 'onPayloadReceived error', err),
        );
      }),
    );

    this.unsubscribers.push(
      this.transport.onPeerConnected((event) => {
        this.handlePeerConnected(event).catch((err) =>
          errm(TAG, 'onPeerConnected error', err),
        );
      }),
    );

    this.unsubscribers.push(
      this.transport.onPeerDisconnected((event) => {
        this.handlePeerDisconnected(event);
      }),
    );

    logm(TAG, 'Event wiring complete');
  }

  private async handlePayloadReceived(event: PayloadReceivedEvent): Promise<void> {
    await this.ensureCrypto();
    const env = deserializeEnvelope(event.data);
    if (!env) {
      logm(TAG, 'Invalid envelope, discarding');
      return;
    }

    // Use composite key for IMAGE chunks (messageId + chunkIndex) so each chunk is dedup'd individually
    const dedupKey = env.type === 'IMAGE'
      ? `${env.message_id}_${env.chunk_index}`
      : env.message_id;
    if (this.dedup.has(dedupKey)) {
      logm(TAG, `Dedup hit: ${dedupKey}`);
      return;
    }
    this.dedup.add(dedupKey);

    if (env.route_history.includes(this.deviceId)) {
      logm(TAG, `Loop: ${this.deviceId} in route_history for ${env.message_id}`);
      return;
    }

    if (env.type === 'ROLE_CREDENTIAL') {
      const fingerprint = keyExchange.registerPeerKey(env.sender_id, env.ciphertext);
      keyExchange.registerPeerKey(event.peerId, env.ciphertext);
      if (env.display_name) {
        this.peerNames.set(env.sender_id, env.display_name);
        this.peerNames.set(event.peerId, env.display_name);
      }
      logm(TAG, `Key exchange: registered key for ${env.sender_id} (ep=${event.peerId}): ${fingerprint.substring(0, 16)}...`);
      await this.persistPeerKey(env.sender_id, env.ciphertext, fingerprint);

      // Create/update PeerSession — handshake is now complete
      const session: PeerSession = {
        fingerprint: env.sender_id,
        endpointId: event.peerId,
        displayName: env.display_name || this.peerNames.get(env.sender_id) || '',
        connectedAt: Date.now(),
      };
      this.peerSessions.set(env.sender_id, session);
      this.endpointToFingerprint.set(event.peerId, env.sender_id);
      this.staleEndpointToFingerprint.delete(event.peerId);
      this.sessionSubscribers.forEach((cb) => cb(session));

      return;
    }

    const ourKeypair = keyManager.getKeypair();
    let plaintext: string | null = null;

    if (env.sender_public_key) {
      try {
        const senderPub = base64ToUint8Array(env.sender_public_key);
        plaintext = decryptFromPeer(
          env.ciphertext,
          env.nonce,
          senderPub,
          ourKeypair.secretKey,
        );
      } catch {
        plaintext = null;
      }
    }

    if (plaintext !== null) {
      keyExchange.registerPeerKey(env.sender_id, env.sender_public_key);
      keyExchange.registerPeerKey(event.peerId, env.sender_public_key);

      // Ensure endpoint→fingerprint mapping exists (handles reconnection edge cases)
      if (!this.endpointToFingerprint.has(event.peerId)) {
        this.endpointToFingerprint.set(event.peerId, env.sender_id);
      }

      if (env.display_name) {
        this.peerNames.set(env.sender_id, env.display_name);
      }

      // Use existing local conversation for this peer to avoid duplicates
      const existingConvId = await this.conversationManager.lookupConversationByPeer(env.sender_id);
      const convId = existingConvId || env.conversation_id || env.message_id;
      const displayName = env.display_name || this.peerNames.get(env.sender_id) || 'Unknown';
      await this.conversationManager.getOrCreateConversation(convId, env.sender_id, displayName);
      if (env.display_name) {
        await this.conversationManager.updatePeerName(convId, env.sender_id, env.display_name);
      }

      // Update session displayName if this is a better value
      const existing = this.peerSessions.get(env.sender_id);
      if (existing && env.display_name && env.display_name !== existing.displayName) {
        const updated: PeerSession = { ...existing, displayName: env.display_name };
        this.peerSessions.set(env.sender_id, updated);
        this.sessionSubscribers.forEach((cb) => cb(updated));
      }

      // Normalize conversation_id to local ID so messages appear in the receiver's chat
      env.conversation_id = convId;

      if (env.type === 'IMAGE') {
        await receiveChunk(
          env.message_id,
          env.chunk_index,
          env.chunk_total,
          plaintext,
          '',
          '',
          0,
        );
        logm(TAG, `Received image chunk ${env.chunk_index + 1}/${env.chunk_total} from ${env.sender_id}`);
      } else {
        await this.persistMessage(env, 'received', plaintext);
        await this.conversationManager.updateLastMessage(convId, plaintext.substring(0, 100), env.type.toLowerCase());
        logm(TAG, `Decrypted message from ${env.sender_id} (ep=${event.peerId}): ${plaintext.substring(0, 50)}`);
        this.decryptedCallbacks.forEach((fn) => fn(env.sender_id, plaintext, env.conversation_id));
      }
    } else {
      logm(TAG, `Received encrypted message from ${env.sender_id} (not decryptable by us — relaying)`);
    }

    if (env.ttl <= 0) {
      logm(TAG, `TTL exhausted for ${env.message_id}`);
      return;
    }

    const relayEnv: MeshEnvelope = {
      ...env,
      ttl: env.ttl - 1,
      route_history: [...env.route_history, this.deviceId],
    };

    const serialized = serializeEnvelope(relayEnv);
    await this.persistPending(relayEnv);

    try {
      await this.transport.broadcast(serialized);
      logm(TAG, `Relayed ${env.message_id} (ttl=${relayEnv.ttl})`);
    } catch {
      logm(TAG, `No peers to relay ${env.message_id}, held in outbox`);
    }
  }

  private async handlePeerConnected(event: PeerConnectedEvent): Promise<void> {
    logm(TAG, `Peer ${event.peerId} connected — exchanging keys`);
    await this.ensureCrypto();

    try {
      const ourKeyB64 = keyManager.getPublicKeyB64();
      const nonce = '';
      const authTag = '';
      const env = createEnvelope(
        'ROLE_CREDENTIAL',
        this.deviceId,
        ourKeyB64,
        '',
        ourKeyB64,
        nonce,
        authTag,
        { displayName: this.displayName },
      );
      const serialized = serializeEnvelope(env);
      await this.transport.sendPayload(event.peerId, serialized);
      logm(TAG, `Sent public key to ${event.peerId}`);
    } catch (err: any) {
      errm(TAG, `Failed to send public key to ${event.peerId}`, err);
    }

    try {
      const pending = await database.get<PendingMessage>('pending_messages')
        .query(
          Q.where('status', 'pending'),
          Q.where('expires_at', Q.gt(Date.now())),
        )
        .fetch();

      logm(TAG, `Found ${pending.length} pending messages to flush`);

      for (const pm of pending) {
        try {
          const target = pm.targetPeerId;
          if (target && target !== event.peerId) continue;

          await this.transport.sendPayload(event.peerId, pm.envelopeJson);
          logm(TAG, `Flushed ${pm.messageId} to ${event.peerId}`);
          await pm.destroyPermanently();
        } catch (err: any) {
          errm(TAG, `Failed to flush ${pm.messageId} to ${event.peerId}`, err);
        }
      }

      await database.get<PendingMessage>('pending_messages')
        .query(Q.where('expires_at', Q.lt(Date.now())))
        .destroyAllPermanently();
      logm(TAG, 'Evicted expired pending messages');
    } catch (err: any) {
      errm(TAG, 'Error flushing pending outbox', err);
    }
  }

  private handlePeerDisconnected(event: { peerId: string }): void {
    const fingerprint = this.endpointToFingerprint.get(event.peerId);
    if (fingerprint) {
      const session = this.peerSessions.get(fingerprint);
      this.staleEndpointToFingerprint.set(event.peerId, fingerprint);
      this.peerSessions.delete(fingerprint);
      this.endpointToFingerprint.delete(event.peerId);
      logm(TAG, `Peer disconnected: ${fingerprint.substring(0, 16)}... (ep=${event.peerId})`);
      if (session) {
        const cleared: PeerSession = { ...session, endpointId: '' };
        this.sessionSubscribers.forEach((cb) => cb(cleared));
      }
    }
  }

  private async persistMessage(env: MeshEnvelope, status: string, decryptedPayload?: string): Promise<string | null> {
    try {
      let recordId: string | null = null;
      await database.write(async () => {
        const record = await database.get<Message>('messages').create((msg) => {
          msg.senderId = env.sender_id;
          msg.receiverId = '';
          msg.conversationId = env.conversation_id || env.message_id;
          msg.type = env.type.toLowerCase() as any;
          msg.payload = decryptedPayload ?? env.ciphertext;
          msg.nonce = env.nonce;
          msg.ttl = env.ttl;
          msg.status = status as any;
        });
        recordId = record.id;
      });
      return recordId;
    } catch (err: any) {
      errm(TAG, 'persistMessage failed', err);
      return null;
    }
  }

  private async updateMessageStatus(recordId: string, status: string): Promise<void> {
    try {
      await database.write(async () => {
        const record = await database.get<Message>('messages').find(recordId);
        await record.update((msg) => {
          msg.status = status as any;
        });
      });
      logm(TAG, `updateMessageStatus: ${recordId} → ${status}`);
    } catch (err: any) {
      errm(TAG, `updateMessageStatus failed for ${recordId}`, err);
    }
  }

  private async persistPending(env: MeshEnvelope, targetPeerId?: string): Promise<void> {
    const expiresAt = Date.now() + Math.max(env.ttl, 1) * 60 * 1000;
    try {
      await database.write(async () => {
        await database.get<PendingMessage>('pending_messages').create((pm) => {
          pm.messageId = env.message_id;
          pm.envelopeJson = serializeEnvelope(env);
          pm.type = env.type;
          pm.targetPeerId = targetPeerId || '';
          pm.ttlAtQueue = env.ttl;
          pm.expiresAt = expiresAt;
          pm.status = 'pending';
        });
      });
    } catch (err: any) {
      errm(TAG, 'persistPending failed', err);
    }
  }

  private async persistPeerKey(peerId: string, publicKeyB64: string, fingerprintHex: string): Promise<void> {
    try {
      await database.write(async () => {
        const existing = await database.get<PeerKey>('peer_keys')
          .query(Q.where('peer_id', peerId))
          .fetch();

        if (existing.length > 0) {
          await existing[0].update((rec) => {
            rec.theirPublicKey = publicKeyB64;
            rec.fingerprintHex = fingerprintHex;
            rec.lastSeenAt = Date.now();
          });
        } else {
          await database.get<PeerKey>('peer_keys').create((rec) => {
            rec.peerId = peerId;
            rec.theirPublicKey = publicKeyB64;
            rec.fingerprintHex = fingerprintHex;
            rec.firstSeenAt = Date.now();
            rec.lastSeenAt = Date.now();
          });
        }
      });
    } catch (err: any) {
      errm(TAG, 'persistPeerKey failed', err);
    }
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

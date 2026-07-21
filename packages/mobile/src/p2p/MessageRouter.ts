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

const TAG = 'ROUTER';

export class MessageRouter {
  private transport: ITransport;
  private dedup: DedupCache;
  private deviceId: string;
  private keyManagerInitialized = false;
  private unsubscribers: (() => void)[] = [];
  private decryptedCallbacks = new Set<(senderId: string, plaintext: string) => void>();

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
    this.wireEvents();
  }

  setDeviceId(id: string): void {
    this.deviceId = id;
  }

  async ensureCrypto(): Promise<void> {
    if (!this.keyManagerInitialized) {
      await keyManager.initialize();
      this.keyManagerInitialized = true;
      this.deviceId = keyManager.getFingerprint();
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
        { ttl: opts?.ttl, chunkIndex: opts?.chunkIndex, chunkTotal: opts?.chunkTotal },
      );
      envelopes.push(env);
      await this.persistMessage(env, 'pending');
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
          { ttl: opts?.ttl, chunkIndex: opts?.chunkIndex, chunkTotal: opts?.chunkTotal },
        );
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
          { ttl: opts?.ttl, chunkIndex: opts?.chunkIndex, chunkTotal: opts?.chunkTotal },
        );
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
      await this.persistMessage(env, 'pending');
    }

    return envelopes;
  }

  async sendToPeer(
    endpointId: string,
    type: EnvelopeType,
    plaintext: string,
    opts?: {
      senderRoleCert?: string;
      ttl?: number;
    },
  ): Promise<MeshEnvelope> {
    await this.ensureCrypto();
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
      { ttl: opts?.ttl },
    );

    const serialized = serializeEnvelope(env);
    await this.persistMessage(env, 'pending');

    try {
      await this.transport.sendPayload(endpointId, serialized);
      logm(TAG, `sendToPeer: sent ${env.message_id} to ${endpointId}`);
    } catch {
      logm(TAG, `sendToPeer: failed to ${endpointId}, queued ${env.message_id}`);
      await this.persistPending(env, endpointId);
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

  subscribeDecrypted(cb: (senderId: string, plaintext: string) => void): () => void {
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

    logm(TAG, 'Event wiring complete');
  }

  private async handlePayloadReceived(event: PayloadReceivedEvent): Promise<void> {
    await this.ensureCrypto();
    const env = deserializeEnvelope(event.data);
    if (!env) {
      logm(TAG, 'Invalid envelope, discarding');
      return;
    }

    if (this.dedup.has(env.message_id)) {
      logm(TAG, `Dedup hit: ${env.message_id}`);
      return;
    }
    this.dedup.add(env.message_id);

    if (env.route_history.includes(this.deviceId)) {
      logm(TAG, `Loop: ${this.deviceId} in route_history for ${env.message_id}`);
      return;
    }

    if (env.type === 'ROLE_CREDENTIAL') {
      const fingerprint = keyExchange.registerPeerKey(env.sender_id, env.ciphertext);
      keyExchange.registerPeerKey(event.peerId, env.ciphertext);
      logm(TAG, `Key exchange: registered key for ${env.sender_id} (ep=${event.peerId}): ${fingerprint.substring(0, 16)}...`);
      await this.persistPeerKey(env.sender_id, env.ciphertext, fingerprint);
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
      await this.persistMessage(env, 'received', plaintext);
      logm(TAG, `Decrypted message from ${env.sender_id} (ep=${event.peerId}): ${plaintext.substring(0, 50)}`);
      this.decryptedCallbacks.forEach((cb) => cb(env.sender_id, plaintext));
    } else {
      await this.persistMessage(env, 'received', env.ciphertext);
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

  private async persistMessage(env: MeshEnvelope, status: string, decryptedPayload?: string): Promise<void> {
    try {
      await database.write(async () => {
        await database.get<Message>('messages').create((msg) => {
          msg.senderId = env.sender_id;
          msg.receiverId = '';
          msg.conversationId = env.message_id;
          msg.type = env.type.toLowerCase() as any;
          msg.payload = decryptedPayload ?? env.ciphertext;
          msg.nonce = env.nonce;
          msg.ttl = env.ttl;
          msg.status = status as any;
        });
      });
    } catch (err: any) {
      errm(TAG, 'persistMessage failed', err);
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

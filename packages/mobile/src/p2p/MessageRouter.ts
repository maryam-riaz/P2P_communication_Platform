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
import { database } from '../db';
import { Message, PendingMessage } from '../db/models';
import { logm, errm } from '../utils/logger';

const TAG = 'ROUTER';

export class MessageRouter {
  private transport: ITransport;
  private dedup: DedupCache;
  private deviceId: string;
  private unsubscribers: (() => void)[] = [];

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

  async sendMessage(
    type: EnvelopeType,
    ciphertext: string,
    nonce: string,
    authTag: string,
    opts?: {
      senderRoleCert?: string;
      ttl?: number;
      chunkIndex?: number;
      chunkTotal?: number;
    },
  ): Promise<MeshEnvelope> {
    const env = createEnvelope(
      type,
      this.deviceId,
      opts?.senderRoleCert || '',
      ciphertext,
      nonce,
      authTag,
      {
        ttl: opts?.ttl,
        chunkIndex: opts?.chunkIndex,
        chunkTotal: opts?.chunkTotal,
      },
    );

    const serialized = serializeEnvelope(env);
    await this.persistMessage(env, 'pending');
    await this.persistPending(env);

    try {
      await this.transport.broadcast(serialized);
      logm(TAG, `sendMessage: broadcast ${env.message_id} (${type})`);
    } catch {
      logm(TAG, `sendMessage: no peers, queued ${env.message_id} for later`);
    }

    return env;
  }

  async sendToPeer(
    endpointId: string,
    type: EnvelopeType,
    ciphertext: string,
    nonce: string,
    authTag: string,
    opts?: {
      senderRoleCert?: string;
      ttl?: number;
    },
  ): Promise<MeshEnvelope> {
    const env = createEnvelope(
      type,
      this.deviceId,
      opts?.senderRoleCert || '',
      ciphertext,
      nonce,
      authTag,
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
    logm(TAG, 'MessageRouter destroyed');
  }

  // ─── Private ──────────────────────────────────────────────────────

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

    await this.persistMessage(env, 'received');

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
      logm(TAG, `Relayed ${env.message_id} (ttl=${relayEnv.ttl}, history=[${relayEnv.route_history.join(',')}])`);
    } catch {
      logm(TAG, `No peers to relay ${env.message_id}, held in outbox`);
    }
  }

  private async handlePeerConnected(event: PeerConnectedEvent): Promise<void> {
    logm(TAG, `Peer ${event.peerId} connected — flushing pending outbox`);

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

      const deleted = await database.get<PendingMessage>('pending_messages')
        .query(Q.where('expires_at', Q.lt(Date.now())))
        .destroyAllPermanently();
      logm(TAG, `Evicted ${deleted} expired pending messages`);
    } catch (err: any) {
      errm(TAG, 'Error flushing pending outbox', err);
    }
  }

  private async persistMessage(env: MeshEnvelope, status: string): Promise<void> {
    try {
      await database.get<Message>('messages').create((msg) => {
        msg.senderId = env.sender_id;
        msg.receiverId = '';
        msg.conversationId = env.message_id;
        msg.type = env.type.toLowerCase() as any;
        msg.payload = env.ciphertext;
        msg.nonce = env.nonce;
        msg.ttl = env.ttl;
        msg.status = status as any;
      });
    } catch (err: any) {
      errm(TAG, 'persistMessage failed', err);
    }
  }

  private async persistPending(env: MeshEnvelope, targetPeerId?: string): Promise<void> {
    const expiresAt = Date.now() + Math.max(env.ttl, 1) * 60 * 1000;
    try {
      await database.get<PendingMessage>('pending_messages').create((pm) => {
        pm.messageId = env.message_id;
        pm.envelopeJson = serializeEnvelope(env);
        pm.type = env.type;
        pm.targetPeerId = targetPeerId || '';
        pm.ttlAtQueue = env.ttl;
        pm.expiresAt = expiresAt;
        pm.status = 'pending';
      });
    } catch (err: any) {
      errm(TAG, 'persistPending failed', err);
    }
  }
}

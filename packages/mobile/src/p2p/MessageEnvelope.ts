import type { MeshEnvelope, EnvelopeType } from '../nearby/types';
import { PER_TYPE_TTL } from '../nearby/types';

export function createEnvelope(
  type: EnvelopeType,
  senderId: string,
  senderPublicKey: string,
  senderRoleCert: string,
  ciphertext: string,
  nonce: string,
  authTag: string,
  opts?: {
    messageId?: string;
    ttl?: number;
    chunkIndex?: number;
    chunkTotal?: number;
    routeHistory?: string[];
    conversationId?: string;
    displayName?: string;
  },
): MeshEnvelope {
  return {
    message_id: opts?.messageId || generateUUID(),
    type,
    sender_id: senderId,
    sender_role_cert: senderRoleCert,
    sender_public_key: senderPublicKey,
    conversation_id: opts?.conversationId || '',
    display_name: opts?.displayName || '',
    ttl: opts?.ttl ?? PER_TYPE_TTL[type],
    timestamp: Date.now(),
    chunk_index: opts?.chunkIndex ?? 0,
    chunk_total: opts?.chunkTotal ?? 1,
    nonce,
    ciphertext,
    auth_tag: authTag,
    route_history: opts?.routeHistory ?? [],
  };
}

export function serializeEnvelope(env: MeshEnvelope): string {
  return btoa(JSON.stringify(env));
}

export function deserializeEnvelope(data: string): MeshEnvelope | null {
  try {
    const parsed = JSON.parse(atob(data));
    if (!parsed.message_id || !parsed.type || !parsed.ciphertext) {
      return null;
    }
    return parsed as MeshEnvelope;
  } catch {
    return null;
  }
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

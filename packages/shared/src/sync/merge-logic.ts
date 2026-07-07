export type SyncVector = Record<string, number>;

export interface Conflict {
  record_id: string;
  local_record: any;
  remote_record: any;
  conflict_description: string;
}

export interface Resolution {
  winner: 'local' | 'remote';
  reason: string;
}

/**
 * Compares and merges two Lamport vector clocks.
 * Causal clock merge: for each key, take the maximum clock value.
 */
export function mergeSyncVectors(local: SyncVector, remote: SyncVector): SyncVector {
  const merged: SyncVector = { ...local };
  for (const [deviceId, clockValue] of Object.entries(remote)) {
    if (merged[deviceId] === undefined || clockValue > merged[deviceId]) {
      merged[deviceId] = clockValue;
    }
  }
  return merged;
}

/**
 * Detects whether concurrent, conflicting updates have occurred for the same record.
 * A conflict is defined as having the same ID, but different content hashes and different timestamps.
 */
export function detectConflict(local: any, remote: any): Conflict | null {
  if (!local || !remote) return null;
  if (local.id !== remote.id) return null;

  if (local.content_hash !== remote.content_hash) {
    const localTime = local.updated_at || local.created_at || 0;
    const remoteTime = remote.updated_at || remote.created_at || 0;
    
    if (localTime !== remoteTime) {
      return {
        record_id: local.id,
        local_record: local,
        remote_record: remote,
        conflict_description: `Content hash mismatch with differing timestamps. Local: ${localTime}, Remote: ${remoteTime}`,
      };
    }
  }
  return null;
}

/**
 * Resolves a detected conflict based on business rules.
 * Rule 1: Rescuer ('responder') role overrides victim ('user') role.
 * Rule 2: Latest timestamp wins.
 */
export function resolveConflict(conflict: Conflict): Resolution {
  const local = conflict.local_record;
  const remote = conflict.remote_record;

  const localRole = local.role || local.sender_role || '';
  const remoteRole = remote.role || remote.sender_role || '';

  // Rescuer (responder) role overrides victim (user)
  if (localRole === 'responder' && remoteRole !== 'responder') {
    return { winner: 'local', reason: 'Rescuer (responder) role overrides victim (user) role' };
  }
  if (remoteRole === 'responder' && localRole !== 'responder') {
    return { winner: 'remote', reason: 'Rescuer (responder) role overrides victim (user) role' };
  }

  // Fallback: Latest timestamp wins
  const localTime = local.updated_at || local.created_at || 0;
  const remoteTime = remote.updated_at || remote.created_at || 0;

  if (localTime >= remoteTime) {
    return { winner: 'local', reason: 'Newer timestamp wins (local is newer or equal)' };
  } else {
    return { winner: 'remote', reason: 'Newer timestamp wins (remote is newer)' };
  }
}

/**
 * Deduplicates a list of messages by grouping them by their SHA-256 content_hash.
 * Retains the first message encountered for each unique hash.
 */
export function deduplicateByHash<T extends { content_hash: string }>(messages: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const msg of messages) {
    if (!seen.has(msg.content_hash)) {
      seen.add(msg.content_hash);
      result.push(msg);
    }
  }
  return result;
}

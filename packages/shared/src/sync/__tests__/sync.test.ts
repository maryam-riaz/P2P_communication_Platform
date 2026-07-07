import { 
  mergeSyncVectors, 
  detectConflict, 
  resolveConflict, 
  deduplicateByHash,
  Conflict
} from '../merge-logic';

describe('Sync Contract Logic Tests', () => {
  // 1. Vector Merge Tests
  describe('mergeSyncVectors', () => {
    it('should correctly merge non-overlapping Lamport clocks', () => {
      const local = { 'device-1': 5 };
      const remote = { 'device-2': 10 };
      const expected = { 'device-1': 5, 'device-2': 10 };

      expect(mergeSyncVectors(local, remote)).toEqual(expected);
    });

    it('should resolve overlapping clocks by choosing the maximum value', () => {
      const local = { 'device-1': 5, 'device-2': 12 };
      const remote = { 'device-2': 8, 'device-3': 1 };
      const expected = { 'device-1': 5, 'device-2': 12, 'device-3': 1 };

      expect(mergeSyncVectors(local, remote)).toEqual(expected);
    });

    it('should update local clocks when remote has higher version values', () => {
      const local = { 'device-1': 3 };
      const remote = { 'device-1': 14 };
      const expected = { 'device-1': 14 };

      expect(mergeSyncVectors(local, remote)).toEqual(expected);
    });
  });

  // 2. Conflict Detection Tests
  describe('detectConflict', () => {
    it('should return null if records have different primary keys', () => {
      const local = { id: 'msg-1', content_hash: 'hash-a', created_at: 100 };
      const remote = { id: 'msg-2', content_hash: 'hash-b', created_at: 200 };

      expect(detectConflict(local, remote)).toBeNull();
    });

    it('should return null if records have identical IDs and identical content hashes', () => {
      const local = { id: 'msg-1', content_hash: 'hash-a', created_at: 100 };
      const remote = { id: 'msg-1', content_hash: 'hash-a', created_at: 200 };

      expect(detectConflict(local, remote)).toBeNull();
    });

    it('should return null if either local or remote is null/undefined', () => {
      expect(detectConflict(null, null)).toBeNull();
      expect(detectConflict({ id: 'msg-1' }, null)).toBeNull();
      expect(detectConflict(null, { id: 'msg-1' })).toBeNull();
    });

    it('should return null if content hashes are different but timestamps are identical', () => {
      const local = { id: 'msg-1', content_hash: 'hash-a', created_at: 100 };
      const remote = { id: 'msg-1', content_hash: 'hash-b', created_at: 100 };
      expect(detectConflict(local, remote)).toBeNull();
    });

    it('should return null if content hashes match but timestamps differ (non-conflicting propagation)', () => {

      const local = { id: 'msg-1', content_hash: 'hash-a', created_at: 100 };
      const remote = { id: 'msg-1', content_hash: 'hash-a', created_at: 150 };

      expect(detectConflict(local, remote)).toBeNull();
    });

    it('should detect a conflict when IDs match, content hashes differ, and timestamps differ', () => {
      const local = { id: 'msg-1', content_hash: 'hash-local', created_at: 100, updated_at: 110 };
      const remote = { id: 'msg-1', content_hash: 'hash-remote', created_at: 100, updated_at: 120 };

      const conflict = detectConflict(local, remote);
      expect(conflict).not.toBeNull();
      expect(conflict?.record_id).toBe('msg-1');
      expect(conflict?.local_record).toEqual(local);
      expect(conflict?.remote_record).toEqual(remote);
      expect(conflict?.conflict_description).toContain('Content hash mismatch');
    });
  });

  // 3. Conflict Resolution Tests
  describe('resolveConflict', () => {
    const makeConflict = (local: any, remote: any): Conflict => ({
      record_id: local.id,
      local_record: local,
      remote_record: remote,
      conflict_description: 'Mock conflict'
    });

    it('should prioritize the rescuer (responder) role over the victim (user) role (local is responder)', () => {
      const local = { id: 'incident-1', role: 'responder', updated_at: 100 };
      const remote = { id: 'incident-1', role: 'user', updated_at: 200 }; // remote is newer but victim
      
      const conflict = makeConflict(local, remote);
      const resolution = resolveConflict(conflict);

      expect(resolution.winner).toBe('local');
      expect(resolution.reason).toContain('Rescuer (responder) role overrides');
    });

    it('should prioritize the rescuer (responder) role over the victim (user) role (remote is responder)', () => {
      const local = { id: 'incident-1', role: 'user', updated_at: 200 };
      const remote = { id: 'incident-1', role: 'responder', updated_at: 100 }; // remote is older but rescuer
      
      const conflict = makeConflict(local, remote);
      const resolution = resolveConflict(conflict);

      expect(resolution.winner).toBe('remote');
      expect(resolution.reason).toContain('Rescuer (responder) role overrides');
    });

    it('should fallback to latest timestamp wins if roles are identical (local is newer)', () => {
      const local = { id: 'incident-1', role: 'user', updated_at: 150 };
      const remote = { id: 'incident-1', role: 'user', updated_at: 100 };
      
      const conflict = makeConflict(local, remote);
      const resolution = resolveConflict(conflict);

      expect(resolution.winner).toBe('local');
      expect(resolution.reason).toContain('Newer timestamp wins');
    });

    it('should fallback to latest timestamp wins if roles are identical (remote is newer)', () => {
      const local = { id: 'incident-1', role: 'responder', updated_at: 300 };
      const remote = { id: 'incident-1', role: 'responder', updated_at: 400 };
      
      const conflict = makeConflict(local, remote);
      const resolution = resolveConflict(conflict);

      expect(resolution.winner).toBe('remote');
      expect(resolution.reason).toContain('Newer timestamp wins');
    });

    it('should fall back to sender_role if role is not present', () => {
      const local = { id: 'incident-1', sender_role: 'responder', updated_at: 100 };
      const remote = { id: 'incident-1', sender_role: 'user', updated_at: 200 };
      const conflict = makeConflict(local, remote);
      const resolution = resolveConflict(conflict);
      expect(resolution.winner).toBe('local');
    });

    it('should fall back to created_at if updated_at is not present', () => {
      const local = { id: 'incident-1', created_at: 150 };
      const remote = { id: 'incident-1', created_at: 100 };
      const conflict = makeConflict(local, remote);
      const resolution = resolveConflict(conflict);
      expect(resolution.winner).toBe('local');
    });

    it('should fall back to 0 if both updated_at and created_at are missing', () => {
      const local = { id: 'incident-1' };
      const remote = { id: 'incident-1', created_at: 5 };
      const conflict = makeConflict(local, remote);
      const resolution = resolveConflict(conflict);
      expect(resolution.winner).toBe('remote'); // remote (5) > local (0)
    });
  });


  // 4. Hash Deduplication Tests
  describe('deduplicateByHash', () => {
    it('should filter out duplicate items based on content_hash', () => {
      const messages = [
        { id: '1', content_hash: 'hash-x', text: 'hello' },
        { id: '2', content_hash: 'hash-y', text: 'world' },
        { id: '3', content_hash: 'hash-x', text: 'hello duplicate' }, // duplicate hash
        { id: '4', content_hash: 'hash-z', text: 'foo' }
      ];

      const deduplicated = deduplicateByHash(messages);

      expect(deduplicated.length).toBe(3);
      expect(deduplicated[0].id).toBe('1');
      expect(deduplicated[1].id).toBe('2');
      expect(deduplicated[2].id).toBe('4');
    });

    it('should return an empty array if input is empty', () => {
      expect(deduplicateByHash([])).toEqual([]);
    });
  });
});

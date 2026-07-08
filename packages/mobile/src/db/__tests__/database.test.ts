import { Database } from '@nozbe/watermelondb';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import { localDbSchema } from '../schema';
import { LocalUser, KnownPeer, Message, SosEvent, LocationLog, SyncQueue } from '../models';
import { MobileRepository } from '../repository';

/**
 * Helper to read raw column values from a WatermelonDB model.
 * In the Jest/ts-jest environment, WatermelonDB decorators (@text, @field)
 * don't work because they require Babel's legacy decorator plugin.
 * The actual React Native app uses Babel and decorators work correctly there.
 * For tests, we verify data integrity through the raw record, which is what
 * the database actually stores and queries against.
 */
function col(record: any, columnName: string): any {
  return record._raw[columnName];
}

describe('WatermelonDB Database Schema and Repository Tests', () => {
  let database: Database;
  let repository: MobileRepository;

  beforeEach(() => {
    const adapter = new LokiJSAdapter({
      schema: localDbSchema,
      useWebWorker: false,
      useIncrementalIndexedDB: false,
    });

    database = new Database({
      adapter,
      modelClasses: [LocalUser, KnownPeer, Message, SosEvent, LocationLog, SyncQueue],
    });

    repository = new MobileRepository(database);
  });

  afterEach(async () => {
    await database.write(async () => {
      await database.unsafeResetDatabase();
    });
  });

  it('should compile the schema and successfully instantiate the database', () => {
    expect(database).toBeDefined();
    expect(repository).toBeDefined();
  });

  describe('LocalUser Operations', () => {
    it('should set and retrieve the local user profile details', async () => {
      const mockUser = {
        deviceId: '11111111-2222-3333-4444-555555555555',
        role: 'responder',
        publicKey: 'mock-public-key-hex',
        displayName: 'Captain John'
      };

      const created = await repository.setLocalUser(mockUser);
      expect(col(created, 'device_id')).toBe(mockUser.deviceId);
      expect(col(created, 'role')).toBe(mockUser.role);
      expect(col(created, 'display_name')).toBe(mockUser.displayName);

      const retrieved = await repository.getLocalUser();
      expect(retrieved).not.toBeNull();
      expect(col(retrieved, 'device_id')).toBe(mockUser.deviceId);
      expect(col(retrieved, 'role')).toBe(mockUser.role);
      expect(col(retrieved, 'display_name')).toBe(mockUser.displayName);
      expect(col(retrieved, 'created_at')).toBeGreaterThan(0);
    });
  });

  describe('KnownPeer Operations', () => {
    it('should add a new peer and query details back', async () => {
      const peerInfo = {
        deviceId: '22222222-3333-4444-5555-666666666666',
        publicKey: 'peer-public-key-hex',
        role: 'user',
        trustStatus: 'trusted'
      };

      const peer = await repository.addNewPeer(peerInfo);
      expect(col(peer, 'device_id')).toBe(peerInfo.deviceId);
      expect(col(peer, 'role')).toBe(peerInfo.role);
      expect(col(peer, 'trust_status')).toBe(peerInfo.trustStatus);

      // Verify lookup by device_id
      const retrieved = await repository.getPeer(peerInfo.deviceId);
      expect(retrieved).not.toBeNull();
      expect(col(retrieved, 'public_key')).toBe(peerInfo.publicKey);
      expect(col(retrieved, 'role')).toBe(peerInfo.role);
    });

    it('should update a peer\'s location and last seen', async () => {
      const peerInfo = {
        deviceId: '22222222-3333-4444-5555-666666666666',
        publicKey: 'peer-public-key-hex',
        role: 'user',
        trustStatus: 'pending'
      };

      await repository.addNewPeer(peerInfo);

      const updated = await repository.updatePeerLocation(peerInfo.deviceId, 34.0522, -118.2437);
      expect(updated).not.toBeNull();
      expect(col(updated, 'last_known_location')).toContain('34.0522');
      expect(col(updated, 'last_known_location')).toContain('-118.2437');
    });
  });

  describe('Messages CRUD Operations', () => {
    it('should insert a message, query it back, and verify all fields intact', async () => {
      const now = Date.now();
      const msgPayload = {
        id: '99999999-8888-7777-6666-555555555555',
        senderId: '11111111-2222-3333-4444-555555555555',
        recipientId: '22222222-3333-4444-5555-666666666666',
        ciphertext: 'base64-aes-ciphertext',
        signature: 'hex-ecdsa-signature',
        contentHash: 'sha256-hash-hex',
        hopCount: 2,
        ttl: 15,
        originDeviceId: '11111111-2222-3333-4444-555555555555',
        syncStatus: 'pending',
        createdAt: now
      };

      // Create message
      const created = await repository.addNewMessage(msgPayload);
      expect(created.id).toBe(msgPayload.id);
      expect(col(created, 'sender_id')).toBe(msgPayload.senderId);
      expect(col(created, 'recipient_id')).toBe(msgPayload.recipientId);
      expect(col(created, 'ciphertext')).toBe(msgPayload.ciphertext);
      expect(col(created, 'signature')).toBe(msgPayload.signature);
      expect(col(created, 'content_hash')).toBe(msgPayload.contentHash);
      expect(col(created, 'hop_count')).toBe(msgPayload.hopCount);
      expect(col(created, 'ttl')).toBe(msgPayload.ttl);
      expect(col(created, 'origin_device_id')).toBe(msgPayload.originDeviceId);
      expect(col(created, 'sync_status')).toBe(msgPayload.syncStatus);
      expect(col(created, 'created_at')).toBe(now);

      // Query message by hash
      const retrievedByHash = await repository.getMessageByHash(msgPayload.contentHash);
      expect(retrievedByHash).not.toBeNull();
      expect(retrievedByHash?.id).toBe(msgPayload.id);

      // Query message by recipient
      const messagesForRecipient = await repository.getMessagesByRecipient(msgPayload.recipientId);
      expect(messagesForRecipient.length).toBe(1);
      expect(messagesForRecipient[0].id).toBe(msgPayload.id);
    });
  });
});

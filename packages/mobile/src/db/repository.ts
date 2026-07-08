import { Database, Q } from '@nozbe/watermelondb';
import { LocalUser, KnownPeer, Message, SosEvent, LocationLog, SyncQueue } from './models';

/**
 * Helper to access the raw record with custom column names.
 * WatermelonDB's _RawRecord type only declares id/_status/_changed,
 * but the actual runtime object contains all schema columns.
 */
function raw(record: { _raw: any }): Record<string, any> {
  return record._raw;
}

export class MobileRepository {
  constructor(private db: Database) {}

  // ==========================================
  // Local User Operations
  // ==========================================

  async getLocalUser(): Promise<LocalUser | null> {
    const users = await this.db.get<LocalUser>('local_user').query().fetch();
    return users.length > 0 ? users[0] : null;
  }

  async setLocalUser(userInfo: {
    deviceId: string;
    role: string;
    publicKey: string;
    displayName: string;
  }): Promise<LocalUser> {
    const existing = await this.getLocalUser();
    return await this.db.write(async () => {
      if (existing) {
        await existing.update((record) => {
          raw(record).role = userInfo.role;
          raw(record).public_key = userInfo.publicKey;
          raw(record).display_name = userInfo.displayName;
        });
        return existing;
      } else {
        return await this.db.get<LocalUser>('local_user').create((record) => {
          raw(record).device_id = userInfo.deviceId;
          raw(record).role = userInfo.role;
          raw(record).public_key = userInfo.publicKey;
          raw(record).display_name = userInfo.displayName;
          raw(record).created_at = Date.now();
        });
      }
    });
  }

  // ==========================================
  // Known Peers Operations
  // ==========================================

  async getPeer(deviceId: string): Promise<KnownPeer | null> {
    const peers = await this.db
      .get<KnownPeer>('known_peers')
      .query(Q.where('device_id', deviceId))
      .fetch();
    return peers.length > 0 ? peers[0] : null;
  }

  async addNewPeer(peerInfo: {
    deviceId: string;
    publicKey: string;
    role: string;
    trustStatus: string;
  }): Promise<KnownPeer> {
    const existing = await this.getPeer(peerInfo.deviceId);
    return await this.db.write(async () => {
      if (existing) {
        await existing.update((record) => {
          raw(record).public_key = peerInfo.publicKey;
          raw(record).role = peerInfo.role;
          raw(record).trust_status = peerInfo.trustStatus;
          raw(record).last_seen = Date.now();
        });
        return existing;
      } else {
        return await this.db.get<KnownPeer>('known_peers').create((record) => {
          raw(record).device_id = peerInfo.deviceId;
          raw(record).public_key = peerInfo.publicKey;
          raw(record).role = peerInfo.role;
          raw(record).trust_status = peerInfo.trustStatus;
          raw(record).last_seen = Date.now();
          raw(record).last_known_location = '';
        });
      }
    });
  }

  async updatePeerLocation(deviceId: string, lat: number, lng: number): Promise<KnownPeer | null> {
    const peer = await this.getPeer(deviceId);
    if (!peer) return null;
    return await this.db.write(async () => {
      await peer.update((record) => {
        raw(record).last_known_location = JSON.stringify({ lat, lng, timestamp: Date.now() });
        raw(record).last_seen = Date.now();
      });
      return peer;
    });
  }

  // ==========================================
  // Messages Operations
  // ==========================================

  async getMessagesByRecipient(recipientId: string): Promise<Message[]> {
    return await this.db
      .get<Message>('messages')
      .query(Q.where('recipient_id', recipientId), Q.sortBy('created_at', Q.asc))
      .fetch();
  }

  async getMessageByHash(hash: string): Promise<Message | null> {
    const msgs = await this.db
      .get<Message>('messages')
      .query(Q.where('content_hash', hash))
      .fetch();
    return msgs.length > 0 ? msgs[0] : null;
  }

  async addNewMessage(msg: {
    id: string; // uuid
    senderId: string;
    recipientId?: string;
    groupId?: string;
    ciphertext: string;
    signature: string;
    contentHash: string;
    hopCount: number;
    ttl: number;
    originDeviceId: string;
    syncStatus: string;
    createdAt?: number;
  }): Promise<Message> {
    const existing = await this.getMessageByHash(msg.contentHash);
    if (existing) return existing;

    return await this.db.write(async () => {
      return await this.db.get<Message>('messages').create((record) => {
        raw(record).id = msg.id;
        raw(record).sender_id = msg.senderId;
        raw(record).recipient_id = msg.recipientId || '';
        raw(record).group_id = msg.groupId || '';
        raw(record).ciphertext = msg.ciphertext;
        raw(record).signature = msg.signature;
        raw(record).content_hash = msg.contentHash;
        raw(record).hop_count = msg.hopCount;
        raw(record).ttl = msg.ttl;
        raw(record).origin_device_id = msg.originDeviceId;
        raw(record).created_at = msg.createdAt || Date.now();
        raw(record).sync_status = msg.syncStatus;
      });
    });
  }

  // ==========================================
  // SOS Events Operations
  // ==========================================

  async createSosEvent(sos: {
    reporterId: string;
    lat: number;
    lng: number;
    accuracy: number;
    locationSource: string;
    severity: string;
    status: string;
    assignedRescuerId?: string;
  }): Promise<SosEvent> {
    return await this.db.write(async () => {
      return await this.db.get<SosEvent>('sos_events').create((record) => {
        raw(record).reporter_id = sos.reporterId;
        raw(record).lat = sos.lat;
        raw(record).lng = sos.lng;
        raw(record).accuracy = sos.accuracy;
        raw(record).location_source = sos.locationSource;
        raw(record).severity = sos.severity;
        raw(record).status = sos.status;
        raw(record).assigned_rescuer_id = sos.assignedRescuerId || '';
        raw(record).created_at = Date.now();
      });
    });
  }

  async getSosEvents(): Promise<SosEvent[]> {
    return await this.db.get<SosEvent>('sos_events').query().fetch();
  }

  // ==========================================
  // Location Log Operations
  // ==========================================

  async logLocation(loc: {
    deviceId: string;
    lat: number;
    lng: number;
    accuracy: number;
    source: string;
  }): Promise<LocationLog> {
    return await this.db.write(async () => {
      return await this.db.get<LocationLog>('location_log').create((record) => {
        raw(record).device_id = loc.deviceId;
        raw(record).lat = loc.lat;
        raw(record).lng = loc.lng;
        raw(record).accuracy = loc.accuracy;
        raw(record).source = loc.source;
        raw(record).timestamp = Date.now();
      });
    });
  }

  // ==========================================
  // Sync Queue Operations
  // ==========================================

  async queueSyncItem(recordType: string, recordId: string): Promise<SyncQueue> {
    return await this.db.write(async () => {
      return await this.db.get<SyncQueue>('sync_queue').create((record) => {
        raw(record).record_type = recordType;
        raw(record).record_id = recordId;
        raw(record).attempts = 0;
        raw(record).last_attempt_at = 0;
        raw(record).created_at = Date.now();
      });
    });
  }

  async getPendingSyncItems(): Promise<SyncQueue[]> {
    return await this.db
      .get<SyncQueue>('sync_queue')
      .query(Q.sortBy('created_at', Q.asc))
      .fetch();
  }
}

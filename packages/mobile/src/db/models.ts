import { Model } from '@nozbe/watermelondb';
import { field, text, readonly } from '@nozbe/watermelondb/decorators';

export class LocalUser extends Model {
  static table = 'local_user';

  @text('device_id') deviceId!: string;
  @text('role') role!: string; // 'user' | 'responder' | 'admin'
  @text('public_key') publicKey!: string;
  @text('display_name') displayName!: string;
  @readonly @field('created_at') createdAt!: number;
}

export class KnownPeer extends Model {
  static table = 'known_peers';

  @text('device_id') deviceId!: string;
  @text('public_key') publicKey!: string;
  @text('role') role!: string; // 'user' | 'responder' | 'admin'
  @field('last_seen') lastSeen!: number;
  @text('last_known_location') lastKnownLocation!: string; // JSON string
  @text('trust_status') trustStatus!: string; // 'trusted' | 'untrusted' | 'pending'
}

export class Message extends Model {
  static table = 'messages';

  @text('sender_id') senderId!: string;
  @text('recipient_id') recipientId!: string;
  @text('group_id') groupId!: string;
  @text('ciphertext') ciphertext!: string;
  @text('signature') signature!: string;
  @text('content_hash') contentHash!: string;
  @field('hop_count') hopCount!: number;
  @field('ttl') ttl!: number;
  @text('origin_device_id') originDeviceId!: string;
  @readonly @field('created_at') createdAt!: number;
  @text('sync_status') localSyncStatus!: string; // 'pending' | 'sent' | 'delivered' | 'failed'
}


export class SosEvent extends Model {
  static table = 'sos_events';

  @text('reporter_id') reporterId!: string;
  @field('lat') lat!: number;
  @field('lng') lng!: number;
  @field('accuracy') accuracy!: number;
  @text('location_source') locationSource!: string; // 'gps' | 'relay' | 'dead-reckoning'
  @text('severity') severity!: string; // 'low' | 'medium' | 'critical'
  @text('status') status!: string; // 'open' | 'assigned' | 'resolved'
  @text('assigned_rescuer_id') assignedRescuerId!: string;
  @readonly @field('created_at') createdAt!: number;
}

export class LocationLog extends Model {
  static table = 'location_log';

  @text('device_id') deviceId!: string;
  @field('lat') lat!: number;
  @field('lng') lng!: number;
  @field('accuracy') accuracy!: number;
  @text('source') source!: string; // 'gps' | 'relay' | 'dead-reckoning'
  @readonly @field('timestamp') timestamp!: number;
}

export class SyncQueue extends Model {
  static table = 'sync_queue';

  @text('record_type') recordType!: string;
  @text('record_id') recordId!: string;
  @field('attempts') attempts!: number;
  @field('last_attempt_at') lastAttemptAt!: number;
  @readonly @field('created_at') createdAt!: number;
}

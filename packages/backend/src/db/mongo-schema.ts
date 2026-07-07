import { ObjectId } from 'mongodb';

export interface MongoMessageDocument {
  _id?: ObjectId;
  id: string; // matches Postgres message id for cross-referencing
  sender_id: string;
  recipient_id: string | null;
  group_id: string | null;
  content_hash: string; // SHA-256
  encrypted_payload: string; // AES-GCM ciphertext
  hop_count: number;
  ttl: number;
  origin_device_id: string;
  message_type: 'text' | 'location_share' | 'sos' | 'system';
  created_at: Date;
  sync_status: 'pending' | 'archived';
}

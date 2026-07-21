import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class PendingMessage extends Model {
  static table = 'pending_messages';

  @field('message_id') messageId!: string;
  @field('envelope_json') envelopeJson!: string;
  @field('type') type!: string;
  @field('target_peer_id') targetPeerId!: string;
  @field('ttl_at_queue') ttlAtQueue!: number;
  @field('expires_at') expiresAt!: number;
  @field('status') status!: 'pending' | 'synced';
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}

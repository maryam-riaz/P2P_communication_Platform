import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class PeerKey extends Model {
  static table = 'peer_keys';

  @field('peer_id') peerId!: string;
  @field('their_public_key') theirPublicKey!: string;
  @field('fingerprint_hex') fingerprintHex!: string;
  @field('first_seen_at') firstSeenAt!: number;
  @field('last_seen_at') lastSeenAt!: number;
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}

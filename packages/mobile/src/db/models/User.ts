import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class User extends Model {
  static table = 'users';

  @field('display_name') displayName!: string;
  @field('role') role!: 'user' | 'rescuer' | 'admin';
  @field('public_key') publicKey!: string;
  @field('public_key_hash') publicKeyHash!: string;
  @field('last_seen_at') lastSeenAt!: number;
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}

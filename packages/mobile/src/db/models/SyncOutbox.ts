import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class SyncOutbox extends Model {
  static table = 'sync_outbox';

  @field('record_id') recordId!: string;
  @field('record_type') recordType!: string;
  @field('operation') operation!: 'create' | 'update' | 'delete';
  @field('status') status!: 'pending' | 'syncing' | 'synced' | 'failed';
  @field('retry_count') retryCount!: number;
  @field('last_error') lastError?: string;
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}

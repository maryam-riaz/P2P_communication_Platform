import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class MediaTransfer extends Model {
  static table = 'media_transfers';

  @field('record_id') recordId!: string;
  @field('message_id') messageId!: string;
  @field('file_name') fileName!: string;
  @field('mime_type') mimeType!: string;
  @field('file_size') fileSize!: number;
  @field('total_chunks') totalChunks!: number;
  @field('received_chunks') receivedChunks!: number;
  @field('local_uri') localUri?: string;
  @field('status') status!: 'receiving' | 'complete' | 'failed';
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}

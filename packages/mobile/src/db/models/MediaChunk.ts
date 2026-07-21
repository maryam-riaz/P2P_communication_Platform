import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class MediaChunk extends Model {
  static table = 'media_chunks';

  @field('record_id') recordId!: string;
  @field('record_type') recordType!: 'message' | 'sos_report';
  @field('chunk_index') chunkIndex!: number;
  @field('chunk_total') chunkTotal!: number;
  @field('data') data!: string;
  @field('nonce') nonce?: string;
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}

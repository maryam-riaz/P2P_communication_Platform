import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class Message extends Model {
  static table = 'messages';

  @field('sender_id') senderId!: string;
  @field('receiver_id') receiverId?: string;
  @field('conversation_id') conversationId!: string;
  @field('type') type!: 'text' | 'image' | 'video_chunk' | 'audio' | 'sos' | 'role_credential';
  @field('payload') payload!: string;
  @field('nonce') nonce?: string;
  @field('ttl') ttl!: number;
  @field('status') status!: 'pending' | 'sent' | 'received' | 'read';
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}

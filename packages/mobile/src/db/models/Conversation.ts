import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class Conversation extends Model {
  static table = 'conversations';

  @field('conversation_id') conversationId!: string;
  @field('last_message_preview') lastMessagePreview?: string;
  @field('last_message_at') lastMessageAt?: number;
  @field('last_message_type') lastMessageType?: string;
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}

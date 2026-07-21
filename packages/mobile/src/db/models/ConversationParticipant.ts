import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export default class ConversationParticipant extends Model {
  static table = 'conversation_participants';

  @field('conversation_id') conversationId!: string;
  @field('peer_id') peerId!: string;
  @field('peer_name') peerName!: string;
  @field('last_read_at') lastReadAt!: number;
  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}

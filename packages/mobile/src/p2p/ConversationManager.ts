import { Q } from '@nozbe/watermelondb';

import { database } from '../db';
import { Conversation, ConversationParticipant } from '../db/models';
import { logm, errm } from '../utils/logger';

const TAG = 'CONV';

export class ConversationManager {
  private db: Database;
  private selfId: string;

  constructor(selfId: string) {
    this.db = database;
    this.selfId = selfId;
  }

  setSelfId(id: string): void {
    this.selfId = id;
  }

  async getOrCreateConversation(
    conversationId: string,
    peerId: string,
    peerName: string,
  ): Promise<string> {
    try {
      const existing = await this.db.get<Conversation>('conversations')
        .query(Q.where('conversation_id', conversationId))
        .fetch();

      if (existing.length > 0) {
        return conversationId;
      }

      await this.db.write(async () => {
        await this.db.get<Conversation>('conversations').create((c) => {
          c.conversationId = conversationId;
        });

        await this.db.get<ConversationParticipant>('conversation_participants').create((p) => {
          p.conversationId = conversationId;
          p.peerId = this.selfId;
          p.peerName = 'me';
          p.lastReadAt = Date.now();
        });

        await this.db.get<ConversationParticipant>('conversation_participants').create((p) => {
          p.conversationId = conversationId;
          p.peerId = peerId;
          p.peerName = peerName;
          p.lastReadAt = 0;
        });
      });

      logm(TAG, `Created conversation ${conversationId} with ${peerName} (${peerId})`);
      return conversationId;
    } catch (err: any) {
      errm(TAG, 'getOrCreateConversation failed', err);
      return conversationId;
    }
  }

  async lookupConversationByPeer(peerId: string): Promise<string | null> {
    try {
      const participants = await this.db.get<ConversationParticipant>('conversation_participants')
        .query(Q.where('peer_id', peerId))
        .fetch();

      for (const p of participants) {
        const siblings = await this.db.get<ConversationParticipant>('conversation_participants')
          .query(
            Q.where('conversation_id', p.conversationId),
            Q.where('peer_id', this.selfId),
          )
          .fetch();

        if (siblings.length > 0) {
          return p.conversationId;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  async updatePeerName(
    conversationId: string,
    peerId: string,
    name: string,
  ): Promise<void> {
    try {
      await this.db.write(async () => {
        const participants = await this.db.get<ConversationParticipant>('conversation_participants')
          .query(
            Q.where('conversation_id', conversationId),
            Q.where('peer_id', peerId),
          )
          .fetch();

        if (participants.length > 0) {
          await participants[0].update((p) => {
            p.peerName = name;
          });
        }
      });
    } catch (err: any) {
      errm(TAG, 'updatePeerName failed', err);
    }
  }

  async updateLastMessage(
    conversationId: string,
    preview: string,
    messageType: string,
  ): Promise<void> {
    try {
      await this.db.write(async () => {
        const existing = await this.db.get<Conversation>('conversations')
          .query(Q.where('conversation_id', conversationId))
          .fetch();

        if (existing.length > 0) {
          await existing[0].update((c) => {
            c.lastMessagePreview = preview;
            c.lastMessageAt = Date.now();
            c.lastMessageType = messageType;
          });
        }
      });
    } catch (err: any) {
      errm(TAG, 'updateLastMessage failed', err);
    }
  }

  async incrementUnread(conversationId: string, senderPeerId: string): Promise<void> {
    if (senderPeerId === this.selfId) return;
  }

  async markRead(conversationId: string, peerId: string): Promise<void> {
    try {
      await this.db.write(async () => {
        const participants = await this.db.get<ConversationParticipant>('conversation_participants')
          .query(
            Q.where('conversation_id', conversationId),
            Q.where('peer_id', peerId),
          )
          .fetch();

        if (participants.length > 0) {
          await participants[0].update((p) => {
            p.lastReadAt = Date.now();
          });
        }
      });
    } catch (err: any) {
      errm(TAG, 'markRead failed', err);
    }
  }

  async getUnreadCount(conversationId: string, peerId: string): Promise<number> {
    try {
      const participant = await this.db.get<ConversationParticipant>('conversation_participants')
        .query(
          Q.where('conversation_id', conversationId),
          Q.where('peer_id', peerId),
        )
        .fetch();

      if (participant.length === 0) return 0;

      const lastRead = participant[0].lastReadAt;

      const unread = await this.db.get<import('../db/models').Message>('messages')
        .query(
          Q.where('conversation_id', conversationId),
          Q.where('sender_id', Q.notEq(peerId)),
          Q.where('created_at', Q.gt(lastRead)),
        )
        .fetch();

      return unread.length;
    } catch {
      return 0;
    }
  }

  observeConversations() {
    return this.db.get<Conversation>('conversations')
      .query()
      .observe();
  }

  observeMessages(conversationId: string) {
    return this.db.get<import('../db/models').Message>('messages')
      .query(
        Q.where('conversation_id', conversationId),
        Q.sortBy('created_at', 'asc'),
      )
      .observe();
  }
}

import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';

import { schema } from './schema';
import { migrations } from './migrations';
import {
  User,
  Message,
  SosReport,
  MediaChunk,
  SyncOutbox,
  PendingMessage,
  PeerKey,
  Conversation,
  ConversationParticipant,
  MediaTransfer,
} from './models';

const adapter = new SQLiteAdapter({
  schema,
  migrations,
  jsi: true,
  onSetUpError: (error) => {
    console.error('WatermelonDB setup error:', error);
  },
});

export const database = new Database({
  adapter,
  modelClasses: [
    User,
    Message,
    SosReport,
    MediaChunk,
    SyncOutbox,
    PendingMessage,
    PeerKey,
    Conversation,
    ConversationParticipant,
    MediaTransfer,
  ],
});

export {
  User,
  Message,
  SosReport,
  MediaChunk,
  SyncOutbox,
  PendingMessage,
  PeerKey,
  Conversation,
  ConversationParticipant,
  MediaTransfer,
};

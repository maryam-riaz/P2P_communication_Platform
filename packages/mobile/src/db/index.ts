import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';

import { schema } from './schema';
import { User, Message, SosReport, MediaChunk, SyncOutbox } from './models';

const adapter = new SQLiteAdapter({
  schema,
  jsi: true,
  onSetUpError: (error) => {
    console.error('WatermelonDB setup error:', error);
  },
});

export const database = new Database({
  adapter,
  modelClasses: [User, Message, SosReport, MediaChunk, SyncOutbox],
});

export { User, Message, SosReport, MediaChunk, SyncOutbox };

import { schemaMigrations, createTable } from '@nozbe/watermelondb/Schema/migrations';

export const migrations = schemaMigrations({
  migrations: [
    {
      version: 2,
      tables: {
        create: [
          createTable({
            name: 'pending_messages',
            columns: [
              { name: 'message_id', type: 'string' },
              { name: 'envelope_json', type: 'string' },
              { name: 'type', type: 'string' },
              { name: 'target_peer_id', type: 'string', isOptional: true },
              { name: 'ttl_at_queue', type: 'number' },
              { name: 'expires_at', type: 'number' },
              { name: 'status', type: 'string' },
              { name: 'created_at', type: 'number' },
              { name: 'updated_at', type: 'number' },
            ],
          }),
        ],
      },
    },
  ],
});

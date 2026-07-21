import { schemaMigrations, createTable } from '@nozbe/watermelondb/Schema/migrations';

export const migrations = schemaMigrations({
  migrations: [
    {
      toVersion: 2,
      steps: [
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
    {
      toVersion: 3,
      steps: [
        createTable({
          name: 'peer_keys',
          columns: [
            { name: 'peer_id', type: 'string', isIndexed: true },
            { name: 'their_public_key', type: 'string' },
            { name: 'fingerprint_hex', type: 'string' },
            { name: 'first_seen_at', type: 'number' },
            { name: 'last_seen_at', type: 'number' },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),
      ],
    },
  ],
});

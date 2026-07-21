import { schemaMigrations, createTable, addColumns } from '@nozbe/watermelondb/Schema/migrations';

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
    {
      toVersion: 4,
      steps: [
        addColumns({
          table: 'media_chunks',
          columns: [
            { name: 'file_name', type: 'string', isOptional: true },
            { name: 'mime_type', type: 'string', isOptional: true },
            { name: 'file_size', type: 'number', isOptional: true },
          ],
        }),
        createTable({
          name: 'media_transfers',
          columns: [
            { name: 'record_id', type: 'string' },
            { name: 'message_id', type: 'string' },
            { name: 'file_name', type: 'string' },
            { name: 'mime_type', type: 'string' },
            { name: 'file_size', type: 'number' },
            { name: 'total_chunks', type: 'number' },
            { name: 'received_chunks', type: 'number' },
            { name: 'local_uri', type: 'string', isOptional: true },
            { name: 'status', type: 'string' },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),
        createTable({
          name: 'conversations',
          columns: [
            { name: 'conversation_id', type: 'string' },
            { name: 'last_message_preview', type: 'string', isOptional: true },
            { name: 'last_message_at', type: 'number', isOptional: true },
            { name: 'last_message_type', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),
        createTable({
          name: 'conversation_participants',
          columns: [
            { name: 'conversation_id', type: 'string', isIndexed: true },
            { name: 'peer_id', type: 'string' },
            { name: 'peer_name', type: 'string' },
            { name: 'last_read_at', type: 'number' },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),
      ],
    },
  ],
});

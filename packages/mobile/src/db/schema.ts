import { appSchema, tableSchema } from '@nozbe/watermelondb';
import { schemaMigrations, addColumns } from '@nozbe/watermelondb/Schema/migrations';

export const localDbMigrations = schemaMigrations({
  migrations: [
    {
      toVersion: 2,
      steps: [
        addColumns({
          table: 'known_peers',
          columns: [
            { name: 'display_name', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
  ],
});

export const localDbSchema = appSchema({
  version: 2,
  tables: [
    tableSchema({
      name: 'local_user',
      columns: [
        { name: 'device_id', type: 'string' },
        { name: 'role', type: 'string' }, // 'user' | 'responder' | 'admin'
        { name: 'public_key', type: 'string' },
        { name: 'display_name', type: 'string' },
        { name: 'created_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'known_peers',
      columns: [
        { name: 'device_id', type: 'string', isIndexed: true },
        { name: 'public_key', type: 'string' },
        { name: 'role', type: 'string' }, // 'user' | 'responder' | 'admin'
        { name: 'display_name', type: 'string', isOptional: true },
        { name: 'last_seen', type: 'number', isIndexed: true },
        { name: 'last_known_location', type: 'string' }, // serialized location
        { name: 'trust_status', type: 'string' }, // 'trusted' | 'untrusted' | 'pending'
      ],
    }),
    tableSchema({
      name: 'messages',
      columns: [
        { name: 'sender_id', type: 'string', isIndexed: true },
        { name: 'recipient_id', type: 'string', isOptional: true },
        { name: 'group_id', type: 'string', isOptional: true },
        { name: 'ciphertext', type: 'string' },
        { name: 'signature', type: 'string' },
        { name: 'content_hash', type: 'string', isIndexed: true },
        { name: 'hop_count', type: 'number' },
        { name: 'ttl', type: 'number' },
        { name: 'origin_device_id', type: 'string' },
        { name: 'created_at', type: 'number', isIndexed: true },
        { name: 'sync_status', type: 'string' }, // 'pending' | 'sent' | 'delivered' | 'failed'
      ],
    }),
    tableSchema({
      name: 'sos_events',
      columns: [
        { name: 'reporter_id', type: 'string' },
        { name: 'lat', type: 'number' },
        { name: 'lng', type: 'number' },
        { name: 'accuracy', type: 'number' },
        { name: 'location_source', type: 'string' }, // 'gps' | 'relay' | 'dead-reckoning'
        { name: 'severity', type: 'string' }, // 'low' | 'medium' | 'critical'
        { name: 'status', type: 'string' }, // 'open' | 'assigned' | 'resolved'
        { name: 'assigned_rescuer_id', type: 'string', isOptional: true },
        { name: 'created_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'location_log',
      columns: [
        { name: 'device_id', type: 'string', isIndexed: true },
        { name: 'lat', type: 'number' },
        { name: 'lng', type: 'number' },
        { name: 'accuracy', type: 'number' },
        { name: 'source', type: 'string' }, // 'gps' | 'relay' | 'dead-reckoning'
        { name: 'timestamp', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'sync_queue',
      columns: [
        { name: 'record_type', type: 'string' },
        { name: 'record_id', type: 'string' },
        { name: 'attempts', type: 'number' },
        { name: 'last_attempt_at', type: 'number', isOptional: true },
        { name: 'created_at', type: 'number' },
      ],
    }),
  ],
});

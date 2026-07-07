# Database Schema Documentation

This document explains the database schemas for the local device database (WatermelonDB/SQLite) and the server-side database (PostgreSQL + MongoDB message archive + Redis cache).

---

## 1. Local Device Database (WatermelonDB / SQLite)

The local device database is optimized for offline-first, peer-to-peer data replication. It tracks the device's identity, known peers, chat & SOS messages, location updates, and sync logs.

### Tables & Fields

#### `local_user`
Stores the identity of the current device. Only one record should exist in this table.
- `id` (String/UUID, PK): Auto-generated unique row ID.
- `device_id` (String/UUID): The hardware UUID of the device.
- `role` (String): Role of the local user (`'user'` = Victim, `'responder'` = Rescuer, `'admin'` = Command Center).
- `public_key` (String): Hex-encoded DER SPKI public key (ECDH/ECDSA key).
- `display_name` (String): Friendly display name for the user.
- `created_at` (Number): Epoch timestamp of profile creation.

#### `known_peers`
Tracks metadata for all peers that the device has discovered over the BLE or Wi-Fi Direct interface.
- `id` (String, PK): Auto-generated unique row ID.
- `device_id` (String/UUID, Indexed): The remote peer's hardware UUID.
- `public_key` (String): Hex-encoded DER SPKI public key of the peer.
- `role` (String): The peer's role.
- `last_seen` (Number, Indexed): Timestamp of the last successful communication/heartbeat.
- `last_known_location` (String): Serialized JSON location object `{lat, lng, timestamp}`.
- `trust_status` (String): Verification status (`'trusted'`, `'untrusted'`, `'pending'`).

#### `messages`
Stores local, peer-to-peer encrypted text messages, SOS messages, and system broadcast packets.
- `id` (String/UUID, PK): The absolute message identifier.
- `sender_id` (String/UUID, Indexed): UUID of the sender.
- `recipient_id` (String/UUID): UUID of the recipient (empty string for broadcast/group).
- `group_id` (String/UUID): UUID of the group (empty string for direct messaging).
- `ciphertext` (String): Base64-encoded encrypted AES-256-GCM payload.
- `signature` (String): Hex-encoded ECDSA digital signature over (ciphertext || iv || tag).
- `content_hash` (String, Indexed): Hex-encoded SHA-256 hash of the decrypted plaintext (used for deduplication).
- `hop_count` (Number): Routing hop count (hops taken to reach this device).
- `ttl` (Number): Time-To-Live hop limit remaining.
- `origin_device_id` (String/UUID): UUID of the device where the message originated.
- `created_at` (Number, Indexed): Timestamp of message creation.
- `sync_status` (String): Sync lifecycle (`'pending'` = outbound queue, `'sent'`, `'delivered'`, `'failed'`).

#### `sos_events`
Stores SOS reports created by the user or relayed from nearby victims.
- `id` (String, PK): Unique row identifier.
- `reporter_id` (String/UUID): The victim's user ID.
- `lat` (Number), `lng` (Number): Coordinates of the emergency location.
- `accuracy` (Number): GPS precision (meters).
- `location_source` (String): Origin of coordinate capture (`'gps'`, `'relay'`, `'dead-reckoning'`).
- `severity` (String): Emergency urgency level (`'low'`, `'medium'`, `'critical'`).
- `status` (String): Lifecycle of rescue (`'open'`, `'assigned'`, `'resolved'`).
- `assigned_rescuer_id` (String/UUID): Rescuer currently coordinating the response.
- `created_at` (Number): Timestamp of event capture.

#### `location_log`
Tracks the history of device movements.
- `id` (String, PK): Row identifier.
- `device_id` (String/UUID, Indexed): UUID of the target device.
- `lat` (Number), `lng` (Number): Logged coordinates.
- `accuracy` (Number): GPS accuracy.
- `source` (String): GPS/sensor source type.
- `timestamp` (Number): Epoch timestamp of coordinate logging.

#### `sync_queue`
Outbox queue tracking local modifications that need to be replicated to the central server when back online.
- `id` (String, PK): Queue ID.
- `record_type` (String): Table name (`'messages'`, `'sos_events'`, `'location_log'`).
- `record_id` (String/UUID): Primary key of the record being synced.
- `attempts` (Number): Number of sync attempts made.
- `last_attempt_at` (Number): Last attempt timestamp.
- `created_at` (Number): Timestamp of queueing.

---

## 2. Server-Side Database (PostgreSQL)

PostgreSQL holds the centralized schema. It is updated by the Server Sync Gateway when clients upload their offline local databases.

### Tables & Relationships

```
  +--------------+          +-------------------+
  |    users     |<--------|   rescuer_teams   |
  +--------------+          +-------------------+
    ^   ^   ^
    |   |   +--------------------------+
    |   +----------------+             |
    |                    |             |
  +--------------+  +-----------+  +------------------+
  |  incidents   |  | msg_arch  |  |   sync_vectors   |
  +--------------+  +-----------+  +------------------+
```

#### `users`
Master profiles for all registered system participants.
- `id` (UUID, PK): Unique system identifier.
- `device_id` (UUID): Client hardware UUID.
- `role` (VARCHAR, CHECK): `'user'`, `'responder'`, or `'admin'`.
- `display_name` (VARCHAR): Display name.
- `public_key` (TEXT): Public key string.
- `verified` (BOOLEAN): Identity verified status.
- `created_at` (TIMESTAMPTZ): Entry timestamp.
- *Constraints*: Unique combination of `(device_id, role)`.

#### `rescuer_teams`
Tactical rescue squads for emergency personnel.
- `id` (UUID, PK): Team assignment identifier.
- `rescuer_id` (UUID, FK -> `users.id`): Active rescuer profile.
- `team_name` (VARCHAR): Assigned division name.
- `status` (VARCHAR, CHECK): Availability state (`'available'`, `'busy'`, `'offline'`).

#### `incidents`
Master list of active emergencies aggregated from client uploads.
- `id` (UUID, PK): Incident unique identifier.
- `origin_device_id` (UUID): Originating client hardware UUID.
- `reporter_id` (UUID, FK -> `users.id`): The reporting user.
- `location` (VARCHAR): Coordinate capture representation.
- `severity` (VARCHAR, CHECK): Urgency levels.
- `status` (VARCHAR, CHECK): Incident resolution stages (`'open'`, `'assigned'`, `'resolved'`).
- `lead_rescuer_id` (UUID, FK -> `users.id`): Coordinator in charge of the incident.
- `created_at` (TIMESTAMPTZ): Start timestamp.
- `resolved_at` (TIMESTAMPTZ): Closure timestamp.

#### `messages_archive`
Encrypted P2P messaging archives saved on server convergence.
- `id` (UUID, PK): Unique message index.
- `sender_id` (UUID, FK -> `users.id`): Originating sender.
- `recipient_id` (UUID, FK -> `users.id`): Designated recipient.
- `content_hash` (VARCHAR, Unique): SHA-256 checksum (prevents duplicated records on multi-route uploads).
- `encrypted_payload` (TEXT): Encrypted AES-GCM block.
- `origin_hop_count` (INTEGER): Route distance metric.
- `created_at` (TIMESTAMPTZ): Creation timestamp.

#### `sync_vectors`
Lamport logical clock values tracked per peer node to maintain transaction causality.
- `device_id` (UUID, PK): Registered device.
- `clock_value` (INTEGER): Lamport clock value.
- `last_update` (TIMESTAMPTZ): Vector tick timestamp.

#### `conflict_log`
Trace diagnostic table tracking details and outcomes of vector replication collisions.
- `id` (UUID, PK): Trace ID.
- `device_id` (UUID): Associated device.
- `conflict_description` (TEXT): Cause of collision.
- `resolution_status` (VARCHAR): Final state (e.g. `'resolved_local_win'`).
- `created_at` (TIMESTAMPTZ): Timestamp.

---

## 3. MongoDB Message Archive (Raw Log)

Used for cold-storage backups of P2P network payloads. Unlike relational tables, this holds the complete unstructured metadata packet.

- `_id`: MongoDB ObjectId.
- `id`: UUID mapping to the Postgres `messages_archive.id`.
- `sender_id`, `recipient_id`, `group_id`: Identifiers.
- `content_hash`: SHA-256 checksum.
- `encrypted_payload`: Ciphertext block.
- `hop_count`, `ttl`: Routing constraints.
- `origin_device_id`: Source node.
- `message_type`: `'text'`, `'location_share'`, `'sos'`, `'system'`.
- `created_at`: Creation date.
- `sync_status`: `'pending'` or `'archived'`.

---

## 4. Redis Cache Key Design (Live State Cache)

Redis keeps track of ephemeral statuses (reachability heartbeats, active responders, and dashboard subscribers).

- **Reachability Hearts**: `device:${device_id}:reachable`
  - *Type*: String
  - *Value*: Heartbeat Unix Epoch.
  - *TTL*: 60s.
- **Rescuer Status**: `rescuer:${rescuer_id}:available`
  - *Type*: String
  - *Value*: Status enum (`'available'`, `'busy'`, `'offline'`).
- **Incident Observers**: `incident:${incident_id}:watchers`
  - *Type*: Set
  - *Value*: Set of rescuer IDs currently watching.

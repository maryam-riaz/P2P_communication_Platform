# Backend API & Workflows

> Source: All files under `packages/backend/src/`

---

## 1. HTTP/API Server Status

**No HTTP server exists in this package.**

The `packages/backend/` directory contains only:
- `src/db/schema.sql` -- PostgreSQL DDL
- `src/db/mongo-schema.ts` -- MongoDB document type definitions
- `src/db/repository.ts` -- Data access layer (`ServerRepository` class)
- `src/cache/redis-config.ts` -- Redis key patterns and client factory

There are **no**:
- Express/Fastify/Koa server files
- Route definitions
- Request/response types
- Authentication middleware
- WebSocket handlers
- GraphQL schemas

The `package.json` references `dist/index.js` as the entry point (line 6), but no `src/index.ts` file exists in the current codebase. This package is a **data access layer only**, intended to be consumed by another service (likely a relay server or API gateway in a different package).

**Dependencies** (`package.json`):
- `pg` ^8.12.0 -- PostgreSQL client
- `mongodb` ^6.7.0 -- MongoDB driver
- `redis` ^4.6.14 -- Redis client
- `shared` workspace:* -- Shared types/utilities from the monorepo

---

## 2. Workflows

### 2.1 User Registration Workflow

```mermaid
sequenceDiagram
    participant Device
    participant Repo as ServerRepository
    participant PG as PostgreSQL

    Device->>Repo: createUser({ id, device_id, role, display_name, public_key, verified })
    Repo->>PG: INSERT INTO users ... RETURNING *
    PG-->>Repo: Inserted user row
    Repo-->>Device: PgUser

    Note over PG: CONSTRAINT unique_device_role<br/>prevents duplicate<br/>device+role combos
```

**Data stored:**
| Store | Data | Notes |
|---|---|---|
| PostgreSQL `users` | `id`, `device_id`, `role`, `display_name`, `public_key`, `verified`, `created_at` | System of record |
| MongoDB | None | Not involved in registration |
| Redis | None | Not involved in registration |

**Validation**: CHECK constraint on `role` limits values to `'user' | 'responder' | 'admin'` (schema.sql:17). UNIQUE constraint on `(device_id, role)` prevents duplicate registrations (schema.sql:22).

---

### 2.2 Incident Management Workflow

```mermaid
sequenceDiagram
    participant Victim as Victim Device
    participant Repo as ServerRepository
    participant PG as PostgreSQL
    participant Redis

    Note over Victim,PG: Phase 1: Create Incident
    Victim->>Repo: createIncident({ id, origin_device_id, reporter_id, location, severity, status: 'open' })
    Repo->>PG: INSERT INTO incidents ... RETURNING *
    PG-->>Repo: Incident (status: open)

    Note over Victim,Redis: Phase 2: Responder Watches Incident
    Victim->>Repo: addIncidentWatcher(incidentId, rescuerId)
    Repo->>Redis: SADD incident:{id}:watchers rescuerId

    Note over Victim,PG: Phase 3: Assign Rescuer
    Victim->>Repo: updateIncidentStatus(id, 'assigned', leadRescuerId)
    Repo->>PG: UPDATE incidents SET status='assigned', lead_rescuer_id=...
    Repo->>Redis: SET rescuer:{id}:available 'busy'

    Note over Victim,PG: Phase 4: Resolve
    Victim->>Repo: updateIncidentStatus(id, 'resolved', leadRescuerId)
    Repo->>PG: UPDATE incidents SET status='resolved', resolved_at=NOW()
    Repo->>Redis: SET rescuer:{id}:available 'available'
```

**State machine:**
```
open --> assigned --> resolved
```

**Data stored per phase:**
| Phase | PostgreSQL | Redis |
|---|---|---|
| Create | `incidents` row (status: `open`) | -- |
| Watch | -- | `incident:{id}:watchers` set gains member |
| Assign | `incidents.status` -> `assigned`, `lead_rescuer_id` set | `rescuer:{id}:available` -> `busy` |
| Resolve | `incidents.status` -> `resolved`, `resolved_at` set | `rescuer:{id}:available` -> `available` |

**Querying**: `listIncidents({ status?, severity? })` supports filtering by either or both fields (repository.ts:90-107).

---

### 2.3 Message Archival Workflow

```mermaid
sequenceDiagram
    participant Mobile as Mobile Device
    participant Repo as ServerRepository
    participant PG as PostgreSQL
    participant Mongo as MongoDB

    Mobile->>Repo: insertMessageArchive({ id, sender_id, recipient_id, content_hash, encrypted_payload, origin_hop_count })
    Repo->>PG: INSERT INTO messages_archive ... ON CONFLICT (content_hash) DO NOTHING RETURNING *

    alt content_hash is new
        PG-->>Repo: Inserted row
        Repo->>Mongo: saveRawMessageToMongo({ id, sender_id, ..., message_type, sync_status, ttl, group_id })
        Mongo-->>Repo: Acknowledged (upsert)
    else content_hash already exists (duplicate)
        PG-->>Repo: null (no row returned)
        Note over Repo: Duplicate silently dropped
    end
```

**Deduplication mechanism:**
1. Mobile computes `content_hash` (SHA-256) of the encrypted payload.
2. PostgreSQL `ON CONFLICT (content_hash) DO NOTHING` silently drops duplicates (repository.ts:121).
3. If `insertMessageArchive` returns `null`, the caller knows it was a duplicate.

**MongoDB vs PostgreSQL storage:**
| Field | PostgreSQL | MongoDB |
|---|---|---|
| `id` | Yes | Yes (cross-reference key) |
| `sender_id` | Yes | Yes |
| `recipient_id` | Yes | Yes |
| `content_hash` | Yes | Yes |
| `encrypted_payload` | Yes | Yes |
| `origin_hop_count` / `hop_count` | Yes (`origin_hop_count`) | Yes (`hop_count`) |
| `created_at` | Yes | Yes |
| `group_id` | No | Yes |
| `ttl` | No | Yes |
| `message_type` | No | Yes |
| `origin_device_id` | No | Yes |
| `sync_status` | No | Yes |

---

### 2.4 Sync Vector Workflow

```mermaid
sequenceDiagram
    participant Device
    participant Repo as ServerRepository
    participant PG as PostgreSQL

    Device->>Repo: updateSyncVector(deviceId, newClockValue)
    Repo->>PG: INSERT INTO sync_vectors ... ON CONFLICT (device_id) DO UPDATE SET clock_value = EXCLUDED.clock_value, last_update = CURRENT_TIMESTAMP

    Note over PG: First sync: INSERT<br/>Subsequent: UPDATE clock_value + timestamp

    Device->>Repo: getSyncVector(deviceId)
    Repo->>PG: SELECT clock_value FROM sync_vectors WHERE device_id = $1
    PG-->>Repo: clock_value (number | null)
    Repo-->>Device: Last known Lamport clock value
```

**Conflict detection flow:**
```mermaid
sequenceDiagram
    participant Device
    participant Repo as ServerRepository
    participant PG as PostgreSQL

    Note over Device: Device sends data with<br/>clock value X
    Device->>Repo: getSyncVector(deviceId)
    Repo-->>Device: Server knows clock value Y

    alt X > Y (newer data)
        Device->>Repo: updateSyncVector(deviceId, X)
        Note over PG: Clock advances to X
    else X <= Y (stale or conflict)
        Device->>Repo: logConflict(deviceId, description, resolutionStatus)
        Repo->>PG: INSERT INTO conflict_log ...
        Note over PG: Diagnostic record created
    end
```

**Key implementation details:**
- `updateSyncVector` uses upsert (`ON CONFLICT ... DO UPDATE`) -- repository.ts:130-136.
- `logConflict` generates a new UUID per conflict via `crypto.randomUUID()` -- repository.ts:146-147.
- `sync_vectors` table has `device_id` as PRIMARY KEY -- one clock per device (schema.sql:78).

---

### 2.5 Device Reachability Workflow

```mermaid
sequenceDiagram
    participant Device
    participant Repo as ServerRepository
    participant Redis

    loop Every N seconds (heartbeat)
        Device->>Repo: setDeviceReachable(deviceId, heartbeatTimestamp, 60)
        Repo->>Redis: SET device:{deviceId}:reachable heartbeatTimestamp EX 60
    end

    Note over Redis: Key expires after 60s<br/>if no heartbeat received

    participant Checker as Status Checker
    Checker->>Repo: isDeviceReachable(deviceId)
    Repo->>Redis: GET device:{deviceId}:reachable

    alt Key exists (heartbeat within TTL)
        Redis-->>Repo: timestamp value
        Repo-->>Checker: true
    else Key expired (no recent heartbeat)
        Redis-->>Repo: null
        Repo-->>Checker: false
    end
```

**Mechanism:**
- **Heartbeat**: Device sends periodic heartbeats via `setDeviceReachable()` with a timestamp and TTL (default 60s) -- repository.ts:179-185.
- **TTL-based detection**: Redis key expires automatically. Absence = offline.
- **No background process needed**: Redis handles expiry natively.

### Rescuer Availability Tracking

```mermaid
sequenceDiagram
    participant Rescuer
    participant Repo as ServerRepository
    participant Redis

    Rescuer->>Repo: setRescuerAvailable(rescuerId, 'available')
    Repo->>Redis: SET rescuer:{rescuerId}:available 'available'

    Note over Redis: No TTL -- persists<br/>until explicitly changed

    Rescuer->>Repo: setRescuerAvailable(rescuerId, 'busy')
    Repo->>Redis: SET rescuer:{rescuerId}:available 'busy'

    participant Dispatcher
    Dispatcher->>Repo: getRescuerStatus(rescuerId)
    Repo->>Redis: GET rescuer:{rescuerId}:available
    Redis-->>Repo: 'busy'
    Repo-->>Dispatcher: 'busy'
```

**Note**: Rescuer availability in Redis is independent of the `rescuer_teams.status` column in PostgreSQL. Redis is the fast-path cache; PostgreSQL is the system of record.

---

### 2.6 Incident Watching Workflow

```mermaid
sequenceDiagram
    participant Responder
    participant Repo as ServerRepository
    participant Redis

    Note over Responder: Responder subscribes<br/>to incident updates

    Responder->>Repo: addIncidentWatcher(incidentId, rescuerId)
    Repo->>Redis: SADD incident:{incidentId}:watchers rescuerId
    Note over Redis: Set automatically<br/>deduplicates

    Responder->>Repo: addIncidentWatcher(incidentId, rescuerId)
    Repo->>Redis: SADD incident:{incidentId}:watchers rescuerId
    Note over Redis: No-op: already a member

    participant Notifier
    Notifier->>Repo: getIncidentWatchers(incidentId)
    Repo->>Redis: SMEMBERS incident:{incidentId}:watchers
    Redis-->>Repo: ['rescuer-uuid-1', 'rescuer-uuid-2', ...]
    Repo-->>Notifier: Array of rescuer IDs
    Notifier->>Notifier: Push updates to all watchers
```

**Key details:**
- Uses Redis `SET` type -- automatic deduplication of watcher IDs (repository.ts:209).
- No TTL on watcher sets -- watchers persist until the set is explicitly modified.
- **Missing feature**: No `removeIncidentWatcher` method exists. Once added, a watcher cannot be removed via the current API.

---

## 3. Missing Features & Gaps

| Feature | Status | Impact |
|---|---|---|
| **HTTP/REST server** | Not implemented | No external API; package is data-layer only |
| **`src/index.ts`** | Referenced in `package.json` but missing | Package cannot start |
| **Authentication middleware** | Not implemented | No request authentication |
| **`removeIncidentWatcher`** | Not implemented | Watchers cannot unsubscribe |
| **Transaction support** | Not implemented | No multi-table atomic operations in repository |
| **`rescuer_teams` CRUD** | Not implemented | Table exists in schema but no repository methods |
| **MongoDB `queryMongoMessages` typing** | `filters: any` | No type safety on Mongo queries |
| **`logConflict` crypto import** | Inline `require('crypto')` | Should be top-level import |
| **Redis `rescuerAvailable` TTL** | No TTL | Status persists forever until overwritten |
| **WebSocket/SSE for watchers** | Not implemented | No real-time push to incident watchers |
| **Pagination on `listIncidents`** | Not implemented | Returns all matching incidents |
| **Soft deletes** | Not implemented | Schema uses `ON DELETE CASCADE` (hard delete) |

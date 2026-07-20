# Backend Repository Layer

> Source: `packages/backend/src/db/repository.ts` (217 lines)

The `ServerRepository` class is the sole data-access layer for the backend. It wraps PostgreSQL, MongoDB, and Redis behind a unified interface.

---

## 1. Constructor & Dependencies

```typescript
// repository.ts:29-34
constructor(
  private pgPool: Pool,
  private mongoDb: Db | null,
  private redisClient: RedisClientType | null
) {}
```

| Dependency | Type | Required | Null-handling |
|---|---|---|---|
| `pgPool` | `Pool` (pg) | **Yes** | Not nullable -- all core operations require Postgres |
| `mongoDb` | `Db` (mongodb) | No | All Mongo methods return early (`return` / `return []`) when null (lines 160, 170) |
| `redisClient` | `RedisClientType` (redis) | No | All Redis methods return early (`return` / `return false` / `return []` / `return null`) when null (lines 180, 188, 195, 201, 207, 213) |

**Design intent**: The system is functional with PostgreSQL alone. MongoDB and Redis are optional enhancements for raw archival and live-state caching respectively.

### TypeScript Interfaces (lines 7-27)

```typescript
interface PgUser {
  id: string;
  device_id: string;
  role: 'user' | 'responder' | 'admin';
  display_name: string;
  public_key: string;
  verified: boolean;
  created_at?: Date;
}

interface PgIncident {
  id: string;
  origin_device_id: string;
  reporter_id: string;
  location: string;
  severity: 'low' | 'medium' | 'critical';
  status: 'open' | 'assigned' | 'resolved';
  lead_rescuer_id: string | null;
  created_at?: Date;
  resolved_at?: Date | null;
}
```

---

## 2. PostgreSQL Operations

### 2.1 `createUser(user: PgUser): Promise<PgUser>` (lines 40-49)

**SQL:**
```sql
INSERT INTO users (id, device_id, role, display_name, public_key, verified, created_at)
VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, CURRENT_TIMESTAMP))
RETURNING *;
```

- Uses `COALESCE($7, CURRENT_TIMESTAMP)` to default `created_at` server-side when not provided.
- Returns the inserted row.
- **No ON CONFLICT handling** -- duplicate `id` or `unique_device_role` violations will throw.

---

### 2.2 `getUser(id: string): Promise<PgUser | null>` (lines 51-55)

**SQL:**
```sql
SELECT * FROM users WHERE id = $1;
```

- Returns `null` if no row found (line 54: `res.rows[0] || null`).

---

### 2.3 `createIncident(incident: PgIncident): Promise<PgIncident>` (lines 57-76)

**SQL:**
```sql
INSERT INTO incidents (id, origin_device_id, reporter_id, location, severity, status, lead_rescuer_id, created_at, resolved_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP), $9)
RETURNING *;
```

- 9 parameters matching all incident columns.
- `COALESCE($8, CURRENT_TIMESTAMP)` defaults `created_at`.
- `$9` (`resolved_at`) passed as null for new incidents.

---

### 2.4 `updateIncidentStatus(id, status, leadRescuerId): Promise<PgIncident | null>` (lines 78-88)

**SQL:**
```sql
UPDATE incidents
SET status = $2, lead_rescuer_id = $3, resolved_at = COALESCE($4, resolved_at)
WHERE id = $1
RETURNING *;
```

- **Auto-sets `resolved_at`**: When `status === 'resolved'`, `resolvedAt` is set to `new Date()` (line 79). Otherwise `null`.
- `COALESCE($4, resolved_at)` preserves existing `resolved_at` when `$4` is null (i.e., non-resolved transitions don't overwrite a previously set resolution time).
- Returns `null` if incident not found.

---

### 2.5 `listIncidents(filters): Promise<PgIncident[]>` (lines 90-107)

**SQL (dynamic):**
```sql
SELECT * FROM incidents WHERE 1=1
  [AND status = $N]
  [AND severity = $N]
ORDER BY created_at DESC;
```

- Builds query dynamically using a parameter counter (`paramCounter`, line 93).
- Filters are optional; both `status` and `severity` can be applied independently.
- Always ordered by `created_at DESC` (newest first).

---

### 2.6 `insertMessageArchive(msg): Promise<any>` (lines 109-127)

**SQL:**
```sql
INSERT INTO messages_archive (id, sender_id, recipient_id, content_hash, encrypted_payload, origin_hop_count, created_at)
VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, CURRENT_TIMESTAMP))
ON CONFLICT (content_hash) DO NOTHING
RETURNING *;
```

- **Deduplication**: `ON CONFLICT (content_hash) DO NOTHING` silently drops duplicate messages.
- Returns `null` when a duplicate is detected (`res.rows[0] || null`, line 126).
- This is the primary mechanism for idempotent message archival.

---

### 2.7 `updateSyncVector(deviceId, clockValue): Promise<void>` (lines 129-137)

**SQL:**
```sql
INSERT INTO sync_vectors (device_id, clock_value, last_update)
VALUES ($1, $2, CURRENT_TIMESTAMP)
ON CONFLICT (device_id) DO UPDATE
SET clock_value = EXCLUDED.clock_value, last_update = CURRENT_TIMESTAMP;
```

- **Upsert pattern**: Inserts for new devices, updates clock for existing devices.
- `EXCLUDED.clock_value` references the would-be-inserted value.
- Always stamps `CURRENT_TIMESTAMP` on `last_update`.

---

### 2.8 `getSyncVector(deviceId): Promise<number | null>` (lines 139-143)

**SQL:**
```sql
SELECT clock_value FROM sync_vectors WHERE device_id = $1;
```

- Returns `null` if device has never synced.

---

### 2.9 `logConflict(deviceId, description, resolutionStatus): Promise<void>` (lines 145-153)

**SQL:**
```sql
INSERT INTO conflict_log (id, device_id, conflict_description, resolution_status, created_at)
VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP);
```

- Generates UUID via `crypto.randomUUID()` (line 147).
- **Note**: Uses `require('crypto')` inline (line 146) rather than a top-level import -- this is a minor code smell.

---

## 3. MongoDB Operations

### 3.1 `saveRawMessageToMongo(doc: MongoMessageDocument): Promise<void>` (lines 159-167)

```typescript
const collection = this.mongoDb.collection<MongoMessageDocument>('messages');
await collection.updateOne(
  { id: doc.id },       // filter: match by logical message id
  { $set: doc },         // update: replace all fields
  { upsert: true }       // insert if not found
);
```

- **Collection**: `messages`
- **Upsert by `id`**: Uses the logical message `id` (not MongoDB `_id`) as the dedup key.
- **`$set` semantics**: Replaces all fields in the document with the provided values.
- **No-op when `mongoDb` is null** (line 160).

---

### 3.2 `queryMongoMessages(filters: any): Promise<MongoMessageDocument[]>` (lines 169-173)

```typescript
const collection = this.mongoDb.collection<MongoMessageDocument>('messages');
return await collection.find(filters).toArray();
```

- Passes arbitrary filter object directly to MongoDB `find()`.
- **No-op when `mongoDb` is null** -- returns empty array (line 170).
- **Note**: The `filters` parameter is untyped (`any`) -- no validation or sanitization.

---

## 4. Redis Operations

### 4.1 `setDeviceReachable(deviceId, heartbeat, ttlSeconds?): Promise<void>` (lines 179-185)

| Parameter | Default | Purpose |
|---|---|---|
| `deviceId` | required | Device identifier |
| `heartbeat` | required | Timestamp value (stored as string) |
| `ttlSeconds` | `60` | Key expiry in seconds |

**Key**: `device:{deviceId}:reachable`
**Command**: `SET key heartbeat EX ttlSeconds`

---

### 4.2 `isDeviceReachable(deviceId): Promise<boolean>` (lines 187-192)

**Key**: `device:{deviceId}:reachable`
**Command**: `GET key`
**Returns**: `true` if key exists (non-null), `false` if absent (expired or never set).

---

### 4.3 `setRescuerAvailable(rescuerId, status): Promise<void>` (lines 194-198)

**Key**: `rescuer:{rescuerId}:available`
**Command**: `SET key status`
**No TTL** -- status persists until explicitly changed.

---

### 4.4 `getRescuerStatus(rescuerId): Promise<string | null>` (lines 200-204)

**Key**: `rescuer:{rescuerId}:available`
**Command**: `GET key`
**Returns**: Status string or `null` if never set.

---

### 4.5 `addIncidentWatcher(incidentId, rescuerId): Promise<void>` (lines 206-210)

**Key**: `incident:{incidentId}:watchers`
**Command**: `SADD key rescuerId`
**Type**: Set -- automatically deduplicates rescuer IDs.

---

### 4.6 `getIncidentWatchers(incidentId): Promise<string[]>` (lines 212-216)

**Key**: `incident:{incidentId}:watchers`
**Command**: `SMEMBERS key`
**Returns**: Array of rescuer ID strings, or empty array if no watchers.

---

## 5. Method Summary Table

| Method | Store | Parameters | Returns | Notable Behavior |
|---|---|---|---|---|
| `createUser` | PG | `PgUser` | `PgUser` | No conflict handling |
| `getUser` | PG | `id` | `PgUser \| null` | |
| `createIncident` | PG | `PgIncident` | `PgIncident` | |
| `updateIncidentStatus` | PG | `id, status, leadRescuerId` | `PgIncident \| null` | Auto-sets `resolved_at` |
| `listIncidents` | PG | `{status?, severity?}` | `PgIncident[]` | Dynamic query, DESC order |
| `insertMessageArchive` | PG | message fields | `any \| null` | `ON CONFLICT DO NOTHING` |
| `updateSyncVector` | PG | `deviceId, clockValue` | `void` | Upsert |
| `getSyncVector` | PG | `deviceId` | `number \| null` | |
| `logConflict` | PG | `deviceId, desc, status` | `void` | Inline `crypto.randomUUID()` |
| `saveRawMessageToMongo` | Mongo | `MongoMessageDocument` | `void` | Upsert by `id` |
| `queryMongoMessages` | Mongo | `filters: any` | `MongoMessageDocument[]` | Untyped filters |
| `setDeviceReachable` | Redis | `deviceId, heartbeat, ttl?` | `void` | TTL-based expiry |
| `isDeviceReachable` | Redis | `deviceId` | `boolean` | Key existence check |
| `setRescuerAvailable` | Redis | `rescuerId, status` | `void` | No TTL |
| `getRescuerStatus` | Redis | `rescuerId` | `string \| null` | |
| `addIncidentWatcher` | Redis | `incidentId, rescuerId` | `void` | Set add |
| `getIncidentWatchers` | Redis | `incidentId` | `string[]` | Set members |

# Backend Workflows

> Source: `packages/backend/src/db/repository.ts`

---

## 1. User Registration Workflow

```mermaid
sequenceDiagram
    participant Client
    participant Repo as ServerRepository
    participant PG as PostgreSQL

    Client->>Repo: createUser({id, device_id, role, display_name, public_key, verified})
    Repo->>PG: INSERT INTO users (id, device_id, role, display_name, public_key, verified, created_at) VALUES (...) RETURNING *
    PG-->>Repo: PgUser row
    Repo-->>Client: PgUser
```

**Constraints enforced by DB:**
- `UNIQUE(device_id, role)` — prevents duplicate registrations
- `CHECK(role IN ('user', 'responder', 'admin'))` — validates role

---

## 2. Incident Management Workflow

### 2.1 Create Incident

```mermaid
sequenceDiagram
    participant Client
    participant Repo as ServerRepository
    participant PG as PostgreSQL

    Client->>Repo: createIncident({id, origin_device_id, reporter_id, location, severity, status='open', ...})
    Repo->>PG: INSERT INTO incidents ... RETURNING *
    PG-->>Repo: PgIncident row
    Repo-->>Client: PgIncident
```

### 2.2 Assign Rescuer

```mermaid
sequenceDiagram
    participant Dispatch
    participant Repo as ServerRepository
    participant PG as PostgreSQL
    participant Redis

    Dispatch->>Repo: updateIncidentStatus(id, 'assigned', leadRescuerId)
    Repo->>PG: UPDATE incidents SET status='assigned', lead_rescuer_id=$3 WHERE id=$1 RETURNING *
    PG-->>Repo: Updated PgIncident
    
    Dispatch->>Repo: setRescuerAvailable(leadRescuerId, 'busy')
    Repo->>Redis: SET rescuer:{leadRescuerId}:available 'busy'
    
    Repo-->>Dispatch: Updated PgIncident
```

### 2.3 Resolve Incident

```mermaid
sequenceDiagram
    participant Rescuer
    participant Repo as ServerRepository
    participant PG as PostgreSQL

    Rescuer->>Repo: updateIncidentStatus(id, 'resolved', null)
    Repo->>PG: UPDATE incidents SET status='resolved', resolved_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *
    Note over PG: resolved_at auto-set when status='resolved'
    PG-->>Repo: Updated PgIncident
    Repo-->>Rescuer: Updated PgIncident
```

### 2.4 List Incidents

```mermaid
sequenceDiagram
    participant Dashboard
    participant Repo as ServerRepository
    participant PG as PostgreSQL

    Dashboard->>Repo: listIncidents({status: 'open', severity: 'critical'})
    Repo->>PG: SELECT * FROM incidents WHERE 1=1 AND status=$1 AND severity=$2 ORDER BY created_at DESC
    PG-->>Repo: PgIncident[]
    Repo-->>Dashboard: Filtered incident list
```

---

## 3. Message Archival Workflow

```mermaid
sequenceDiagram
    participant Client
    participant Repo as ServerRepository
    participant PG as PostgreSQL
    participant Mongo as MongoDB

    Client->>Repo: insertMessageArchive({id, sender_id, recipient_id, content_hash, encrypted_payload, origin_hop_count})
    
    Repo->>PG: INSERT INTO messages_archive ... ON CONFLICT (content_hash) DO NOTHING RETURNING *
    
    alt content_hash already exists
        PG-->>Repo: null (conflict, skipped)
    else New message
        PG-->>Repo: Inserted row
    end
    
    Note over Repo: Also save raw document to MongoDB
    Repo->>Mongo: updateOne({id}, {$set: doc}, {upsert: true})
    Note over Mongo: Full metadata including group_id, ttl, message_type
```

**Deduplication**: PostgreSQL `ON CONFLICT (content_hash) DO NOTHING` prevents duplicate messages from being archived when the same message arrives via multiple mesh paths.

---

## 4. Sync Vector Workflow

```mermaid
sequenceDiagram
    participant Client
    participant Repo as ServerRepository
    participant PG as PostgreSQL

    Client->>Repo: updateSyncVector(deviceId, clockValue)
    Repo->>PG: INSERT INTO sync_vectors (device_id, clock_value, last_update) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (device_id) DO UPDATE SET clock_value=EXCLUDED.clock_value, last_update=CURRENT_TIMESTAMP
    Note over PG: Upsert — insert if new, update if exists
    
    Client->>Repo: getSyncVector(deviceId)
    Repo->>PG: SELECT clock_value FROM sync_vectors WHERE device_id = $1
    PG-->>Repo: clock_value (number or null)
    Repo-->>Client: clock_value
```

**Purpose**: Lamport logical clocks track causal ordering of events across devices. Each device maintains its own clock value, updated on every sync.

---

## 5. Device Reachability Workflow

```mermaid
sequenceDiagram
    participant Device
    participant Repo as ServerRepository
    participant Redis

    loop Every heartbeat
        Device->>Repo: setDeviceReachable(deviceId, heartbeatTimestamp, ttl=60)
        Repo->>Redis: SET device:{deviceId}:reachable {heartbeatTimestamp} EX 60
        Note over Redis: Key expires after 60s if not refreshed
    end
    
    participant Dashboard
    Dashboard->>Repo: isDeviceReachable(deviceId)
    Repo->>Redis: GET device:{deviceId}:reachable
    alt Key exists
        Redis-->>Repo: timestamp string
        Repo-->>Dashboard: true (device online)
    else Key expired
        Redis-->>Repo: null
        Repo-->>Dashboard: false (device offline)
    end
```

**TTL-based liveness**: Device is considered offline if no heartbeat received within 60 seconds.

---

## 6. Incident Watching Workflow

```mermaid
sequenceDiagram
    participant Rescuer
    participant Repo as ServerRepository
    participant Redis

    Rescuer->>Repo: addIncidentWatcher(incidentId, rescuerId)
    Repo->>Redis: SADD incident:{incidentId}:watchers {rescuerId}
    Note over Redis: Set automatically deduplicates
    
    participant Dashboard
    Dashboard->>Repo: getIncidentWatchers(incidentId)
    Repo->>Redis: SMEMBERS incident:{incidentId}:watchers
    Redis-->>Repo: rescuerId[]
    Repo-->>Dashboard: List of watching rescuer IDs
```

> **Flag:** No `removeIncidentWatcher` method exists. Once a rescuer subscribes, they cannot unsubscribe. The set grows unbounded.

---

## 7. Conflict Logging Workflow

```mermaid
sequenceDiagram
    participant SyncEngine
    participant Repo as ServerRepository
    participant PG as PostgreSQL

    SyncEngine->>SyncEngine: Detect vector clock conflict
    SyncEngine->>Repo: logConflict(deviceId, description, resolutionStatus)
    Repo->>Repo: crypto.randomUUID() for conflict ID
    Repo->>PG: INSERT INTO conflict_log (id, device_id, conflict_description, resolution_status, created_at) VALUES (...)
    PG-->>Repo: success
```

**Purpose**: Audit trail for debugging sync conflicts. Records which device caused the conflict, what the conflict was, and how it was resolved.

---

## 8. Rescuer Availability Workflow

```mermaid
sequenceDiagram
    participant Rescuer
    participant Repo as ServerRepository
    participant Redis

    Rescuer->>Repo: setRescuerAvailable(rescuerId, 'available')
    Repo->>Redis: SET rescuer:{rescuerId}:available 'available'
    
    Note over Rescuer: Rescuer takes on incident
    Rescuer->>Repo: setRescuerAvailable(rescuerId, 'busy')
    Repo->>Redis: SET rescuer:{rescuerId}:available 'busy'
    
    Note over Rescuer: Rescuer goes offline
    Rescuer->>Repo: setRescuerAvailable(rescuerId, 'offline')
    Repo->>Redis: SET rescuer:{rescuerId}:available 'offline'
    
    participant Dispatch
    Dispatch->>Repo: getRescuerStatus(rescuerId)
    Repo->>Redis: GET rescuer:{rescuerId}:available
    Redis-->>Repo: status string
    Repo-->>Dispatch: 'available' | 'busy' | 'offline'
```

**Note**: No TTL on rescuer status keys. Status persists until explicitly changed.

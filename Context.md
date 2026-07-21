# Context

## Phase 0 — Foundations & Spike (✅ Completed)

**Goal:** Validate two Android devices can discover & exchange bytes via Google Nearby Connections with no internet.

### What shipped
- **WatermelonDB schema** — 5 tables (users, messages, sos_reports, media_chunks, sync_outbox), SQLite adapter, Babel decorator `version: 'legacy'`
- **Supabase project** `nzrnatlfaqqxozymahnx` — schema, RLS policies, triggers, public buckets `sos-media` & `user-avatars`
- **Android Nearby Connections native module** — `NearbyConnectionsModule.kt` + `NearbyConnectionsPackage.kt`, `Strategy.P2P_STAR`, auto-accept, JS event bridge
- **iOS Multipeer Connectivity stub** — Swift + ObjC bridge (blocked — no macOS/Xcode)
- **Unified transport layer** — `MeshTransport.ts`, `NearbyConnections.ts`, `NearbySpikeScreen.tsx`, Expo Router route `app/spike.tsx`
- **Environment config** — `.env` (gitignored), `.env.example`, `app.config.js`, `supabase.ts` reads from `Constants.expoConfig.extra`

### Spike result
Two Samsung devices (A33, A32) exchanged "hello world" bytes over Nearby Connections.

### Bugs fixed
1. Babel: `{ legacy: true }` → `{ version: 'legacy' }`
2. Kotlin import: `connections.*` → `connection.*` (singular)
3. Runtime permission errors 8029/8038: added `requestNearbyPermissions()` before advertising/discovery

---

## Phase 1 — Native Mesh Transport Module (✅ Completed)

**Goal:** Productionize the Phase 0 spike into a robust RN bridge with explicit connection lifecycle, reconnection, multiple simultaneous peers, and foreground service.

### What changed
- **Cleanup:** Removed unused `BleAdvertiserModule.kt`, `WifiDirectModule.kt`, `WifiDirectPackage.kt` — `CommsPackage.kt` now only registers `NearbyConnectionsModule`
- **Android `NearbyConnectionsModule.kt` rewritten:**
  - Explicit `connect(endpointId)` — no more auto-connect on discovery; discoverer decides when to invite
  - Payload transfer progress events (`onPayloadProgress`)
  - Reconnection with exponential backoff (1s → 60s, max 5 attempts) on unexpected disconnect
  - Duplicate connection guard + mutex for start/stop
  - Standardized error codes (`ERR_ADVERTISE_FAILED`, `ERR_CONNECT_FAILED`, etc.)
  - `getRSSI()` stub (deferred to Phase 6)
  - `startAdvertising()` takes optional `deviceName` parameter
- **`MeshForegroundService.kt`** — Android foreground service with persistent notification, auto-starts/stops with advertising/discovery
- **`AndroidManifest.xml`** — added `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_CONNECTED_DEVICE` permissions + service declaration
- **TypeScript `types.ts`** — formal `ITransport` interface, `PeerState` enum, typed events
- **`MeshTransport.ts` rewritten** — peer state machine, connection timeout (15s), idempotent event subscriptions, broadcast pre-check, `getAllPeers()`
- **`NearbyConnections.ts`** — exposes new methods (`connect`, `getRSSI`, `stopAdvertising`, `stopDiscovery`) and events (`onPayloadProgress`, `onReconnecting`, `onReconnectionFailed`); fallback stubs when native module unavailable
- **iOS `MultipeerConnectivityModule.swift/.m`** — explicit connect, reconnection with `Timer`-based backoff, consistent event names with Android, RSSI stub
- **`NearbySpikeScreen.tsx`** — peer list with state badges + CONNECT/DISCONNECT buttons per peer, Alert on error, payload progress bar
- **`src/utils/logger.ts`** — tagged diagnostic logging utility (`logm`/`errm`/`warnm`/`logNativeCall`)
- **`packages/mobile/logs/`** — gitignored directory for adb logcat capture output

### Verification result
Two Samsung devices (A33 API 36, A32 API 33) — bidirectional "hello world" exchange with explicit connect, no crashes:
- Advertiser: startAdvertising → onEndpointConnected → broadcast → onPayloadReceived ✅
- Discoverer: startDiscovery → onEndpointFound → connect → onEndpointConnected → broadcast → onPayloadReceived ✅

### Bugs fixed in Phase 1
1. Missing `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_CONNECTED_DEVICE` permissions — crash on API 34+ when `MeshForegroundService.startForeground()` called
2. `remoteEndpointIds cannot be empty` — added broadcast pre-check with clear message
3. Peer list never showed discovered peers — added `getAllPeers()` + fixed `subscribeToPlatformEvents()` to run in `advertise()` too
4. Silent failures when native module unavailable — added fallback stubs with diagnostic errors

### What's blocked
- iOS Multipeer Connectivity — needs macOS/Xcode to build & test
- RSSI — `getRSSI()` stubbed; real integration deferred to Phase 6 (Mapping)
- Background behavior on iOS (needs testing with macOS)

### Relevant paths
- `Architecture.md` — source of truth for all phases, detailed Phase 1 implementation docs
- `packages/mobile/android/app/src/main/java/.../NearbyConnectionsModule.kt`
- `packages/mobile/android/app/src/main/java/.../MeshForegroundService.kt`
- `packages/mobile/src/nearby/types.ts` — ITransport interface, PeerState, typed events
- `packages/mobile/src/nearby/MeshTransport.ts` — peer state machine, reconnection manager
- `packages/mobile/src/nearby/NearbyConnections.ts` — native module wrapper + permissions
- `packages/mobile/src/screens/app/NearbySpikeScreen.tsx` — test UI
- `packages/mobile/src/utils/logger.ts` — diagnostic logging utility
- `packages/mobile/android/app/src/main/AndroidManifest.xml` — permissions + service declaration

---

## Phase 2 — Multi-Hop Routing Layer (✅ Completed — 3-device chain test pending)

**Goal:** Implement DTN-style store-and-carry-forward flood routing on top of the Phase 1 single-hop transport, enabling message relay across intermediate devices.

### What changed
- **Envelope format** — `MeshEnvelope` interface in `src/nearby/types.ts` matching Architecture.md §3.2: `message_id`, `type`, `sender_id`, `sender_role_cert`, `ttl`, `timestamp`, `chunk_index`, `chunk_total`, `nonce`, `ciphertext`, `auth_tag`, `route_history`
- **Per-type TTL defaults** — `TEXT:5`, `IMAGE:4`, `VIDEO_CHUNK:3`, `AUDIO:4`, `SOS:7`, `ROLE_CREDENTIAL:2`, `CHATBOT:3`
- **`src/p2p/MessageEnvelope.ts`** — `createEnvelope()`, `serializeEnvelope()` (struct→JSON→base64), `deserializeEnvelope()` (reverse)
- **`src/p2p/DedupCache.ts`** — Set-based `message_id` dedup (1000-entry FIFO cap, 5-minute TTL sweep)
- **`src/p2p/MessageRouter.ts`** — Core routing singleton:
  - `sendMessage()` builds envelope → broadcasts + persists to WatermelonDB + pending outbox
  - `onPayloadReceived` → deserialize → dedup → loop check → persist → TTL decrement → re-broadcast (flood)
  - `onPeerConnected` → flushes pending outbox to newly connected peer (store-carry-forward)
- **`src/p2p/index.ts`** — exports `messageRouter` singleton (wraps `meshTransport`)
- **WatermelonDB changes:** schema version 1→2, new `pending_messages` table + `PendingMessage` model + migration
- **`src/screens/app/MeshRoutingScreen.tsx`** — test UI with type picker, message send, routing log, status bar

### Files changed
| File | Action |
|---|---|
| `src/nearby/types.ts` | EDITED — added envelope + routing types |
| `src/p2p/MessageEnvelope.ts` | CREATED |
| `src/p2p/DedupCache.ts` | CREATED |
| `src/p2p/MessageRouter.ts` | CREATED |
| `src/p2p/index.ts` | CREATED |
| `src/db/schema.ts` | EDITED — version 2, +pending_messages |
| `src/db/migrations.ts` | CREATED — v1→2 migration |
| `src/db/models/PendingMessage.ts` | CREATED |
| `src/db/models/index.ts` | EDITED |
| `src/db/index.ts` | EDITED |
| `src/screens/app/MeshRoutingScreen.tsx` | CREATED |

### Verification result
- **2-device regression pass** ✅ — A33 ↔ A32 bidirectional exchange works, no regressions from Phase 1
- **3-device multi-hop chain (A→B→C)** ⏳ — Not yet tested; requires third physical Android device

### What's blocked
- Multi-hop relay verification — needs third Android device
- Store-carry-forward across device churn — needs extended multi-device session testing

### Relevant paths
- `Architecture.md` — source of truth for all phases, detailed Phase 2 implementation docs
- `packages/mobile/src/nearby/types.ts` — MeshEnvelope, EnvelopeType, PER_TYPE_TTL
- `packages/mobile/src/p2p/MessageRouter.ts` — flood routing, store-carry-forward
- `packages/mobile/src/p2p/DedupCache.ts` — message_id dedup
- `packages/mobile/src/p2p/MessageEnvelope.ts` — envelope serialization
- `packages/mobile/src/db/migrations.ts` — v1→2 schema migration
- `packages/mobile/src/screens/app/MeshRoutingScreen.tsx` — test UI

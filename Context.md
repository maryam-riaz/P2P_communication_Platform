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

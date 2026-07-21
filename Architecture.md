# Offline P2P Disaster Communication Platform — Architecture & Implementation Plan

## 1. Overview

A React Native (Expo) application enabling communication between nearby devices without internet or cellular connectivity, purpose-built for disaster response. Messages, media, and SOS reports propagate across a multi-hop mesh of phones, with opportunistic sync to a cloud backend whenever any device regains connectivity.

**Core roles:** `user`, `rescuer`, `admin`
**Core features:** multi-hop mesh chat (text, audio, video, images), GPS/RSSI-based mapping, SOS reporting to an admin dashboard, on-device emergency chatbot.

---

## 2. Confirmed Architecture Decisions

| Concern | Decision | Rationale |
|---|---|---|
| P2P transport | Google Nearby Connections API (Android) + Multipeer Connectivity (iOS), custom native modules | Only viable offline discovery/transport layer on each platform; no maintained RN wrapper exists, so native bridge work is required |
| Multi-hop relay | **Required.** Custom store-and-carry-forward (DTN-style) routing layer built on top of single-hop transport | Nearby Connections/Multipeer only provide direct/single-hop connections; multi-hop must be built by us |
| Local storage | WatermelonDB | Fast, offline-first, reactive, plays well with sync queues |
| Cloud backend | Supabase (Postgres + Auth + Realtime + Storage) | Row Level Security maps naturally to RBAC; Postgres suits structured SOS/report data; Realtime feeds the admin dashboard |
| Role-based access (offline) | Server-signed credentials (public-key verification on-device) | No auth server reachable mid-disaster; devices must verify roles locally |
| Mapping | `expo-location` (GPS) with `react-native-ble-plx` RSSI fallback + trilateration/fingerprinting | GPS-first, degrades gracefully when unavailable |
| Media over mesh | **Required — highest priority feature.** Chunked, multi-hop relayed, encrypted per chunk | Getting photo/video evidence out of a disaster zone is the platform's core value |
| Encryption | **Kept on for all content, including video.** Asymmetric handshake once per session (X25519) + symmetric AES-GCM per chunk | Bulk encryption cost is negligible (hardware AES acceleration); real bottleneck is mesh radio bandwidth, not crypto — dropping encryption doesn't meaningfully speed transfer but does remove protection over sensitive victim data |
| Chatbot | On-device intent classifier + semantic search over curated emergency/first-aid knowledge base (small embedding model) | Tiny footprint, works on old/low-power hardware, no dependency on a full LLM |

---

## 3. System Architecture

### 3.1 Layers

```
┌─────────────────────────────────────────────┐
│  UI Layer (Expo / React Native)              │
│  Screens: Chat, Map, SOS Form, Admin Dash,   │
│  Role-gated navigation, Chatbot              │
├─────────────────────────────────────────────┤
│  App Logic Layer                              │
│  - Message/SOS composition & validation       │
│  - Role verification (public key checks)      │
│  - Chatbot intent + retrieval engine           │
├─────────────────────────────────────────────┤
│  Mesh Networking Layer (native modules)       │
│  - Discovery / connection (Nearby / Multipeer)│
│  - Multi-hop routing (store & forward, TTL,   │
│    dedup, flood/epidemic routing)             │
│  - Chunked payload transfer (media)           │
├─────────────────────────────────────────────┤
│  Security Layer                               │
│  - Session key exchange (X25519)              │
│  - Per-chunk AES-GCM encryption                │
│  - Role credential signing/verification        │
├─────────────────────────────────────────────┤
│  Local Persistence (WatermelonDB)             │
│  - Messages, SOS reports, media chunks queue,  │
│    contacts/identities, sync outbox            │
├─────────────────────────────────────────────┤
│  Cloud Sync Gateway (opportunistic)           │
│  - Any device with connectivity uploads queued │
│    SOS reports / media / messages to Supabase  │
└─────────────────────────────────────────────┘
                     │
                     ▼
        ┌─────────────────────────┐
        │   Supabase (cloud)       │
        │  Postgres + RLS + Auth   │
        │  Realtime + Storage      │
        └─────────────────────────┘
                     │
                     ▼
        ┌─────────────────────────┐
        │   Admin Dashboard (web)  │
        └─────────────────────────┘
```

### 3.2 Message & Media Wire Format (designed together, not bolted on)

Every unit relayed across the mesh — chat text, image, video chunk, SOS form — shares a common envelope so routing, encryption, and role-verification logic is uniform:

```
Envelope {
  message_id        // UUID, globally unique, used for dedup during flood routing
  type              // TEXT | IMAGE | VIDEO_CHUNK | AUDIO | SOS | ROLE_CREDENTIAL | CHATBOT (n/a)
  sender_id         // device/user identity (public key fingerprint)
  sender_role_cert  // signed role credential (verified via server public key)
  ttl               // hop count remaining, decremented per relay
  timestamp
  chunk_index       // for media: which chunk (0-indexed)
  chunk_total        // for media: total chunk count
  nonce             // per-chunk, for AES-GCM
  ciphertext        // AES-GCM encrypted payload (chunk content)
  auth_tag
  route_history     // optional: device IDs already traversed, to avoid loops
}
```

- **Text/SOS/small payloads:** single-chunk envelope.
- **Images/video/audio:** split into 64–256KB chunks, each independently encrypted and independently relayable/retriable. A receiver reassembles once all `chunk_total` pieces arrive (out of order is fine).
- **Multi-hop routing:** flood/epidemic routing with TTL and `message_id` dedup (each node remembers recently-seen IDs to avoid re-relaying infinite loops). Acceptable for a disaster mesh where node density is unpredictable and no stable routing table can be assumed.
- **Encryption placement:** asymmetric key exchange (X25519) happens once per pairwise session between sender and ultimate recipient; intermediate relay nodes never decrypt — they only forward ciphertext chunks. This keeps the crypto cost off the multi-hop-heavy path (relaying) and on the two-endpoint-only path (encrypt once, decrypt once).

---

## 4. Role-Based Access (Offline Model)

1. Server (Supabase) issues each user a signed role credential when the device has connectivity (onboarding, periodic refresh), signed with the server's private key.
2. The app embeds the server's **public key** at build time.
3. Every device verifies a peer's role credential locally, offline, using that public key — no network call needed.
4. Credentials should have a bounded expiry (e.g., 90 days) refreshed opportunistically whenever connectivity is available, to bound the damage of a compromised/stale credential without requiring constant online verification.
5. Admin-only and rescuer-only actions (e.g., viewing the SOS dashboard, being addressable as a rescuer in chat) are gated by verifying this credential, not by a client-side flag.

---

## 5. Phased Implementation Plan

> Each phase should end in a working, demoable increment. Do not skip Phase 0 or Phase 2 — they de-risk the hardest unknowns (native mesh modules, multi-hop routing) before feature work builds on top of them.

### Phase 0 — Foundations & Spike ✅ (Completed)

> **Duration:** ~1.5 weeks  
> **Devices used:** Samsung Galaxy A33 (advertiser/discoverer), Samsung Galaxy A32 (advertiser/discoverer)  
> **Deliverable verified:** Two Android devices exchanged "hello world" bytes via Nearby Connections with no internet.

#### 0.1 — WatermelonDB Schema Skeleton

**Files created:** `packages/mobile/src/db/`

| File | Purpose |
|---|---|
| `schema.ts` | `appSchema` with 5 tables: `users`, `messages`, `sos_reports`, `media_chunks`, `sync_outbox` |
| `models/User.ts` | Model with `displayName`, `role` (enum: user/rescuer/admin), `publicKey`, `publicKeyHash`, `lastSeenAt` |
| `models/Message.ts` | Model with `senderId`, `receiverId` (optional), `conversationId`, `type` (text/image/video_chunk/audio/sos/role_credential), `payload`, `nonce`, `ttl`, `status` (pending/sent/received/read) |
| `models/SosReport.ts` | Model with `senderId`, `title`, `description`, `latitude`, `longitude`, `severity` (low/medium/high/critical), `status` (open/acknowledged/resolved) |
| `models/MediaChunk.ts` | Polymorphic model with `recordId`, `recordType` (message/sos_report), `chunkIndex`, `chunkTotal`, `data`, `nonce` |
| `models/SyncOutbox.ts` | Sync queue model with `recordId`, `recordType`, `operation` (create/update/delete), `status` (pending/syncing/synced/failed), `retryCount`, `lastError` |
| `index.ts` | Database initialization with `SQLiteAdapter` + all model classes registered |

**Dependencies added:**
- `@nozbe/watermelondb` ^0.28.0
- `@babel/plugin-proposal-decorators` (dev, for WatermelonDB's legacy decorators)

**Config changes:**
- `babel.config.js` — added `['@babel/plugin-proposal-decorators', { version: 'legacy' }]`

#### 0.2 — Supabase Project Setup

**Files created:**

| File | Purpose |
|---|---|
| `src/lib/supabase.ts` | Client initialized with project URL + anon key |
| `src/db/migrations/001_initial_supabase.sql` | Full migration script |

**Schema applied to `nzrnatlfaqqxozymahnx` project:**
- Custom types: `user_role`, `message_type`, `message_status`, `sos_severity`, `sos_status`, `sync_operation`, `sync_status`
- `profiles` table (extends `auth.users` with `display_name`, `role`, `public_key`, `public_key_hash`, `last_seen_at`)
- `messages`, `sos_reports`, `media_chunks`, `sync_outbox` tables matching WatermelonDB schema
- Indexes on `conversation_id`, `sender_id`, `receiver_id`, `status` columns
- Row Level Security enabled on all tables with per-role policies
- `updated_at` trigger function on all tables
- `handle_new_user()` trigger to auto-create profile on signup

**Storage buckets created:** `sos-media` (public), `user-avatars` (public)

#### 0.3 — Android Spike: Nearby Connections Native Module

**Files created:**

| File | Purpose |
|---|---|
| `android/.../NearbyConnectionsModule.kt` | Main native module (260 lines) |
| `android/.../NearbyConnectionsPackage.kt` | ReactPackage registration (17 lines) |
| `android/.../CommsPackage.kt` | Updated to register NearbyConnectionsModule |

**Native module API (`NativeModules.NearbyConnections`):**

| Method | Description |
|---|---|
| `startAdvertising(serviceId)` | Advertise as discoverable using `P2P_STAR` strategy |
| `startDiscovery(serviceId)` | Discover nearby advertising devices |
| `sendPayload(endpointId, base64Data)` | Send bytes to a specific endpoint |
| `sendPayloadToAll(base64Data)` | Broadcast bytes to all connected endpoints |
| `stopAdvertising()` / `stopDiscovery()` | Stop advertising/discovery |
| `disconnectFromEndpoint(endpointId)` | Disconnect from a single endpoint |
| `stopAll()` | Disconnect all endpoints + stop advertising/discovery |
| `getConnectedEndpoints()` | Return list of connected endpoint IDs |

**Events emitted to JS:**

| Event | Payload |
|---|---|
| `onEndpointFound` | `{ endpointId, endpointName, serviceId }` |
| `onEndpointLost` | `{ endpointId }` |
| `onConnectionInitiated` | `{ endpointId, endpointName, authenticationToken, isIncomingConnection }` |
| `onEndpointConnected` | `{ endpointId }` |
| `onEndpointDisconnected` | `{ endpointId, statusCode? }` |
| `onPayloadReceived` | `{ endpointId, data (base64) }` |

**Key implementation details:**
- Uses `Strategy.P2P_STAR` (star topology — any device can connect to any other)
- Auto-accepts incoming connections for the spike (no pairing UI)
- Auto-invites discovered endpoints on `onEndpointFound` (no manual connect step)
- Registration via `CommsPackage` in `MainApplication.kt`

**Dependencies added:**
- `com.google.android.gms:play-services-nearby:19.3.0` in `app/build.gradle`

**Permissions required (in `AndroidManifest.xml`):**
- `BLUETOOTH_ADVERTISE`, `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` (Android 12+)
- `NEARBY_WIFI_DEVICES` (Android 13+)
- `ACCESS_FINE_LOCATION` (Android 11 and below)
- `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE`, `INTERNET`

**Runtime permission flow (JS-side via `PermissionsAndroid`):**
- Before every `startAdvertising` or `startDiscovery` call, the JS layer calls `requestNearbyPermissions()` which uses `PermissionsAndroid.requestMultiple()` with the correct permission set for the API level
- System dialog appears; advertising/discovery proceeds only after all permissions granted

#### 0.4 — iOS Spike: Multipeer Connectivity (Stub)

**Files created:** `src/nearby/ios/`

| File | Purpose |
|---|---|
| `MultipeerConnectivityModule.m` | Obj-C bridge (RCT_EXTERN_MODULE declarations) |
| `MultipeerConnectivityModule.swift` | Swift implementation using `MCNearbyServiceAdvertiser`, `MCNearbyServiceBrowser`, `MCSession` |

**Status:** Source code ready. Full integration requires:
1. `npx expo prebuild --platform ios` to generate ios/ directory (requires macOS)
2. Add files to Xcode project
3. Link `MultipeerConnectivity.framework`
4. Set development team to `TEAM_ID_APPLE_DEV`

#### 0.5 — Unified JS Transport Layer

**Files created:** `src/nearby/`

| File | Purpose |
|---|---|
| `NearbyConnections.ts` | TypeScript wrapper for `NativeModules.NearbyConnections` + `requestNearbyPermissions()` |
| `MeshTransport.ts` | Platform-abstracted transport API (dispatches to Android Nearby or iOS Multipeer) |
| `NearbySpikeScreen.tsx` | Test screen with event log + persist received payloads to WatermelonDB |
| `app/spike.tsx` | Expo Router route exposing NearbySpikeScreen at `/spike` |

**`MeshTransport` unified API:**

| Method | Description |
|---|---|
| `startAdvertising()` | Starts advertising on current platform |
| `startDiscovery()` | Starts discovery on current platform |
| `sendToAll(data)` | Broadcasts base64 payload to all connected peers |
| `stopAll()` | Stops all transport activity |
| `getConnectedPeers()` | Returns list of connected peer IDs |
| `persistReceivedMessage(endpointId, base64Data)` | Writes received payload to WatermelonDB |

**Access in app:** "Nearby Spike Test" button added to Profile screen → routes to `/spike`.

#### 0.6 — Bugs Encountered & Fixed

| Bug | Root Cause | Fix |
|---|---|---|
| `The decorators plugin requires a 'version' option` | Babel 8 requires new decorator plugin syntax | Changed `{ legacy: true }` → `{ version: 'legacy' }` in `babel.config.js` |
| `Unresolved reference 'connections'` | Wrong import package — used plural `connections` instead of singular `connection` | Fixed import to `com.google.android.gms.nearby.connection` |
| `Error 8029: missing permission NEARBY_WIFI_DEVICES` | Runtime permission not requested on Android 13+ | Added `requestNearbyPermissions()` using `PermissionsAndroid.requestMultiple()` before advertising/discovery |
| `Error 8038: missing permission BLUETOOTH_ADVERTISE` | Runtime permission not requested on Android 12+ | Same fix — included in the permission set

### Phase 1 — Native Mesh Transport Module (2–4 weeks)
- Build the RN bridge exposing a unified JS API: `advertise()`, `discover()`, `connect()`, `sendPayload()`, `onPayloadReceived()`, `disconnect()`, `getRSSI()`.
- Implement per-platform native code (Kotlin: Nearby Connections; Swift: Multipeer Connectivity).
- Handle connection lifecycle: reconnection, multiple simultaneous peers, backgrounding behavior.
- Deliverable: JS-level API that reliably sends/receives byte payloads between 2+ devices per platform.

### Phase 2 — Multi-Hop Routing Layer (3–4 weeks)
- Implement the envelope format (Section 3.2) on top of the Phase 1 transport.
- Implement flood/epidemic routing: TTL decrement, `message_id` dedup cache, loop avoidance.
- Implement store-and-carry-forward: a device holds messages it can't yet deliver/relay further and re-attempts on next peer contact.
- Test with 3+ physical devices in a chain (A cannot reach C directly, only via B) to prove multi-hop actually works — this is the feature that differentiates the app.
- Deliverable: a message sent from Device A reaches Device C via Device B relay, with no direct A↔C connection.

### Phase 3 — Security Layer (2–3 weeks)
- Implement X25519 key exchange for pairwise sessions (TOFU or QR-pairing for initial identity trust).
- Implement AES-GCM chunk encryption/decryption integrated into the envelope.
- Implement role credential issuance (Supabase-side signing) and offline verification (client-side, public key baked into build).
- Deliverable: messages between two devices are unreadable by relaying intermediaries; role credentials verify correctly offline.

### Phase 4 — Chat (Text, Images) Over Mesh (2–3 weeks)
- Wire the existing chat UI to the mesh transport + routing + security layers.
- Implement chunked image transfer with reassembly and progress indication in UI.
- Persist all messages locally via WatermelonDB; implement conversation/thread model.
- Deliverable: two (and then three, relayed) devices exchange encrypted text and images with no internet.

### Phase 5 — Audio/Video Over Mesh (3–5 weeks) — highest priority per product goals
- Implement chunked media transfer for recorded audio/video files (not necessarily live calls — prioritize *getting evidence out*, which is store-and-forward, over live calling, which requires single-hop only and lower priority given goals).
- Add compression/bitrate reduction step before chunking (this — not encryption — is the actual lever for mesh transfer speed).
- Implement resumable/retriable chunk transfer (critical for lossy, intermittent mesh links).
- If live audio/video calling is still wanted, scope it explicitly as **single-hop only** (direct connection) and build separately from the store-and-forward media pipeline.
- Deliverable: a recorded video clip on Device A successfully arrives at Device C via multi-hop relay through Device B, encrypted end-to-end.

### Phase 6 — Mapping (2–3 weeks)
- Integrate `expo-location` for GPS-based positioning.
- Integrate `react-native-ble-plx` to read RSSI from nearby devices when GPS is unavailable.
- Implement fallback localization (trilateration if 3+ reference points available, else weighted-centroid approximation).
- Render both GPS-based and RSSI-approximated positions on the map UI, with a clear visual distinction (e.g., precise pin vs. approximate radius) so users/rescuers understand the confidence level.
- Deliverable: device location displays on map via GPS; when GPS is disabled/unavailable, an approximate location still renders from RSSI data.

### Phase 7 — SOS Form & Admin Dashboard Sync (2–3 weeks)
- Build SOS form submission (structured data + optional photo/video attachment), routed through the same mesh/multi-hop/encryption pipeline as chat.
- Implement the sync outbox: any device that regains connectivity uploads queued SOS reports (and referenced media) to Supabase.
- Build/connect the admin dashboard (web) reading from Supabase via Realtime, gated by the `admin` role.
- Deliverable: an SOS submitted on a device with no connectivity reaches a rescuer device via mesh, and is separately synced to the admin dashboard once any device in the chain regains internet.

### Phase 8 — Role-Based Access Enforcement Across the App (1–2 weeks)
- Gate all screens/actions by verified role credential (not just SOS/admin dashboard): chat visibility, map visibility of rescuer/admin markers, chatbot access, etc.
- Implement credential refresh flow (opportunistic, whenever connectivity is available).
- Deliverable: a `user` cannot access admin/rescuer-only views even with a tampered client, since verification is cryptographic, not a local flag.

### Phase 9 — On-Device Chatbot (2–3 weeks)
- Curate the emergency/first-aid/disaster-protocol knowledge base content.
- Build/integrate a small on-device embedding model for semantic search over that knowledge base.
- Build the intent classifier + retrieval + response UI flow.
- Deliverable: chatbot answers common emergency questions fully offline, using only on-device inference.

### Phase 10 — Hardening, Battery/Performance Optimization, Field Testing (3–4 weeks)
- Battery profiling: mesh advertising/discovery is radio-intensive; tune discovery duty cycles.
- Multi-device field tests (5–10+ physical devices) simulating real disaster density and mobility patterns.
- Failure-mode testing: message loss, partial media transfer recovery, credential expiry mid-disaster, device churn (peers appearing/disappearing).
- Security review: confirm relay nodes never access plaintext, confirm role credential forgery is not possible, confirm key exchange resists basic MITM in the TOFU/QR pairing flow.
- Deliverable: app is stable and performant under realistic multi-device, intermittent-connectivity conditions.

### Phase 11 — Cloud Admin Dashboard Polish & Launch Readiness (2–3 weeks)
- Finalize Supabase RLS policies for production.
- Dashboard UX: SOS triage, live status of rescuer devices, historical reports.
- App store / Play Store submission prep (permissions justification for location, Bluetooth, background service usage will need clear explanation to reviewers given the app's nature).

---


## 6. Key Risks to Track

| Risk | Mitigation |
|---|---|
| ~~Native mesh modules are the single largest unknown/effort sink~~ | ✅ **Phase 0 retired this risk.** Two Android devices exchanged bytes via Nearby Connections. iOS Multipeer Connectivity source code ready; integration blocked on macOS access. |
| Multi-hop routing reliability under real-world device churn | Dedicated Phase 2 with physical multi-device chain testing, not just simulator/two-device testing |
| Video transfer speed over BLE/Wi-Fi Direct mesh | Addressed via compression + chunking + resumable transfer, not by dropping encryption |
| Cross-platform (Android↔iOS) direct P2P has real limitations without a shared Wi-Fi AP | Scope realistic expectations early; may need same-platform assumption for true multi-hop in v1, with cross-platform as a stretch goal |
| Battery drain from constant advertising/discovery | Tuned duty cycles, addressed explicitly in Phase 10 |
| Role credential compromise | Bounded expiry + opportunistic refresh, not indefinite trust |
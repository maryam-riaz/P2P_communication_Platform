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

### Phase 1 — Native Mesh Transport Module ✅ (Completed)

> **Duration:** ~2.5 weeks (actual)  
> **Devices used:** Samsung Galaxy A33 (API 36), Samsung Galaxy A32 (API 33)  
> **Deliverable verified:** Two Android devices exchanged "hello world" bytes bidirectionally with explicit connect, foreground service, reconnection events, and no crashes.

---

#### 1.1 — Cleanup: Remove Unused Native Modules

**Files deleted:**

| File | Reason |
|---|---|
| `BleAdvertiserModule.kt` | Unused BLE peripheral module (replaced by Nearby Connections) |
| `WifiDirectModule.kt` | Unused Wi-Fi Direct module (replaced by Nearby Connections) |
| `WifiDirectPackage.kt` | ReactPackage registration for the above |

**Files edited:**

| File | Change |
|---|---|
| `CommsPackage.kt` | Removed `BleAdvertiserModule` and `WifiDirectModule`; now registers only `NearbyConnectionsModule` |
| `MainApplication.kt` | Updated comment to reflect single transport module |

---

#### 1.2 — TypeScript `ITransport` Interface & Types

**File created:** `src/nearby/types.ts`

| Export | Description |
|---|---|
| `PeerState` enum | `Found` → `Connecting` → `Connected` → `Disconnecting` → `Disconnected` → `Reconnecting` |
| `PeerInfo` | Full peer descriptor: `endpointId`, `displayName`, `state`, `lastSeen`, `rssi`, `reconnectAttempts` |
| `ITransport` interface | Formal contract for the transport layer with 8 methods + 7 event subscriptions |
| Event types | `PeerFoundEvent`, `PeerLostEvent`, `PeerConnectedEvent`, `PeerDisconnectedEvent`, `PayloadReceivedEvent`, `PayloadProgressEvent`, `ReconnectingEvent` |
| `AdvertiseOptions` | `deviceName?` + `serviceId?` |
| Constants | `SERVICE_ID_DEFAULT`, `CONNECT_TIMEOUT_MS` (15s), `RECONNECT_BASE_DELAY_MS`, `RECONNECT_MAX_ATTEMPTS` (5) |

**`ITransport` interface:**

```typescript
interface ITransport {
  advertise(options?: AdvertiseOptions): Promise<void>;
  discover(serviceId?: string): Promise<void>;
  connect(endpointId: string): Promise<void>;
  disconnect(endpointId: string): Promise<void>;
  sendPayload(endpointId: string, data: string): Promise<void>;
  broadcast(data: string): Promise<void>;
  getConnectedPeers(): Promise<PeerInfo[]>;
  getAllPeers(): PeerInfo[];
  getRSSI(endpointId: string): Promise<number | null>;
  stopAdvertising(): Promise<void>;
  stopDiscovery(): Promise<void>;
  stopAll(): Promise<void>;
  // Event subscriptions return unsubscribe functions
  onPeerFound / onPeerLost / onPeerConnected / onPeerDisconnected / onPayloadReceived / onPayloadProgress / onReconnecting
}
```

---

#### 1.3 — Android Native Module Rewrite

**File rewritten:** `NearbyConnectionsModule.kt` (260→380 lines)

**Native module API (`NativeModules.NearbyConnections`):**

| Method | Old (Phase 0) | New (Phase 1) |
|---|---|---|
| `startAdvertising` | `(serviceId)` | `(serviceId, deviceName)` — added optional device name |
| `stopAdvertising` | same | same |
| `startDiscovery` | `(serviceId)` | same |
| `stopDiscovery` | — | **NEW** — stop discovery independently |
| `connect` | — | **NEW** — explicit connection to a discovered endpoint |
| `disconnectFromEndpoint` | same | same |
| `sendPayload` | same | same |
| `sendPayloadToAll` | same | same |
| `getConnectedEndpoints` | same | same |
| `getRSSI` | — | **NEW** — stub (returns error; deferred to Phase 6) |
| `stopAll` | same | same |

**Events emitted to JS:**

| Event | Phase 0 | Phase 1 |
|---|---|---|
| `onEndpointFound` | ✅ yes | ✅ yes |
| `onEndpointLost` | ✅ yes | ✅ yes |
| `onConnectionInitiated` | ✅ yes | ✅ yes |
| `onEndpointConnected` | ✅ yes | ✅ yes |
| `onEndpointDisconnected` | ✅ yes | ✅ **added `unexpected` boolean** |
| `onPayloadReceived` | ✅ yes | ✅ yes |
| `onPayloadProgress` | — | ✅ **NEW** — bytes transferred / total bytes / status |
| `onReconnecting` | — | ✅ **NEW** — attempt / maxAttempts |
| `onReconnectionFailed` | — | ✅ **NEW** — gave up after max attempts |

**Key implementation changes:**

1. **Explicit connect** — `onEndpointFound` no longer auto-invokes `requestConnection`. Instead, discovered endpoints are cached in `discoveredEndpoints` map. JS calls `connect(endpointId)` which invokes `requestConnection` on demand.

2. **Payload transfer progress** — `payloadCallback.onPayloadTransferUpdate` now emits `onPayloadProgress` events with `bytesTransferred`, `totalBytes`, and `status` (`in_progress` / `success` / `failure`).

3. **Reconnection with exponential backoff** — When `onDisconnected` fires unexpectedly (and peer is still in discovered cache), a reconnection timer starts with jittered exponential backoff: 1s → 2s → 4s → 8s → ... → 60s max. Cancelled if `disconnectFromEndpoint()` or `stopAll()` is called. After 5 failed attempts, emits `onReconnectionFailed`.

4. **Duplicate connection guard** — `pendingConnections` set prevents duplicate `requestConnection` calls to the same endpoint. `isAdvertising` / `isDiscovering` booleans prevent double-start.

5. **Standardized error codes** — Every `promise.reject` uses consistent `ERR_*` prefixes:
   - `ERR_ADVERTISE_FAILED`, `ERR_DISCOVERY_FAILED`, `ERR_CONNECT_FAILED`, `ERR_ENDPOINT_NOT_FOUND`, `ERR_SEND_FAILED`, `ERR_SEND_ALL_FAILED`, `ERR_DISCONNECT_ERROR`, `ERR_STOP_ALL_ERROR`, `ERR_RSSI_NOT_AVAILABLE`

6. **Foreground service integration** — `startForegroundService(reactContext)` companion object method starts the mesh foreground service on advertising/discovery begin, stops it when both stop.

---

#### 1.4 — Android Foreground Service

**File created:** `MeshForegroundService.kt`

| Feature | Detail |
|---|---|
| **Notification channel** | `sosify-mesh` (ID), `"Mesh Communication"` (name), `IMPORTANCE_LOW` |
| **Persistent notification** | Title: `"Mesh Active"`, body: `"N peer(s) connected"` or `"Listening for nearby devices..."` |
| **Lifecycle** | Started via `context.startForegroundService(intent)` when advertising or discovery begins. Stops when both stop. Uses `START_STICKY` to survive brief kills. |
| **Manifest declaration** | `<service android:name=".MeshForegroundService" android:foregroundServiceType="connectedDevice" android:exported="false" />` |

**Permission requirements (in `AndroidManifest.xml`):**
- `FOREGROUND_SERVICE` (API 28+ for any `startForeground()` call)
- `FOREGROUND_SERVICE_CONNECTED_DEVICE` (API 34+ for `connectedDevice` type)
- Existing: Bluetooth, WiFi, Nearby permissions from Phase 0

---

#### 1.5 — JS Transport Layer Rewrite

**Files edited:**
- `src/nearby/NearbyConnections.ts` — enhanced native wrapper
- `src/nearby/MeshTransport.ts` — rewritten with peer state machine
- `src/nearby/index.ts` — updated exports

##### `NearbyConnections.ts` (Phase 1)

Wraps every native method with pre/post diagnostic logging. Exposes new methods:

| Method | Description |
|---|---|
| `requestNearbyPermissions()` | Requests NEARBY_WIFI_DEVICES, BLUETOOTH_ADVERTISE/SCAN/CONNECT per API level |
| `startAdvertising(serviceId, deviceName?)` | Calls native with two params |
| `startDiscovery(serviceId)` | Calls native |
| `connect(endpointId)` | **NEW** — explicit connect |
| `disconnectFromEndpoint(endpointId)` | Calls native |
| `sendPayload(endpointId, data)` | Calls native |
| `sendPayloadToAll(data)` | Calls native |
| `getConnectedEndpoints()` | Returns native endpoint list |
| `getRSSI(endpointId)` | **NEW** — stub, returns null |
| `onReconnecting(handler)` | **NEW** — reconnection attempt events |
| `onReconnectionFailed(handler)` | **NEW** — reconnection exhausted |

**Fallback stubs:** If native module is null (e.g., bridgeless interop failure), every method throws a clear diagnostic error rather than silently returning null.

##### `MeshTransport.ts` (Phase 1)

Rewritten from thin platform-dispatch layer to full peer state machine:

| Component | Detail |
|---|---|
| **Peer state machine** | Internal `Map<endpointId, PeerInfo>` tracks every peer through `Found → Connecting → Connected → Disconnected` with `Reconnecting` for failure recovery |
| **Connection timeout** | 15-second timeout per `connect()` call. If `onEndpointConnected` doesn't fire within 15s, peer marked as `Disconnected` and an error is thrown. |
| **Idempotent event subscription** | `subscribeToPlatformEvents()` called from both `advertise()` and `discover()` with a `platformEventsSubscribed` guard preventing duplicate listener registration |
| **Broadcast pre-check** | `broadcast()` queries `getConnectedEndpoints()` before sending; throws `"No peers connected. Discover and connect first."` if empty |
| **`getAllPeers()`** | **NEW** — returns all tracked peers (both `Found` and `Connected`), used by UI to show the peer list with CONNECT buttons |
| **Event normalization** | Native `endpointId` → JS `peerId`; all event types normalized from platform-specific naming |
| **Cleanup** | `stopAll()` clears all timeouts, unsubscribes all event listeners, clears peer map |

---

#### 1.6 — iOS Multipeer Connectivity Enhancements

**Files edited:** `src/nearby/ios/MultipeerConnectivityModule.swift` and `.m`

| Change | Detail |
|---|---|
| **Explicit connect** | Removed auto-invite from `browser(_:foundPeer:)`. Added `@objc func connect(_ peerId:)` that calls `browser.invitePeer(...)` |
| **`startAdvertising`** | Added `deviceName` parameter (second string arg) mirroring Android |
| **`startDiscovery`** | Renamed from `startBrowsing` to match Android naming |
| **`getRSSI`** | **NEW** — stub, reject with `ERR_RSSI_NOT_AVAILABLE` |
| **Reconnection** | Timer-based exponential backoff (1s→60s, max 5 attempts) when `session(didChange: .notConnected)` fires for a previously connected peer |
| **Event names** | Renamed to match Android: `onEndpointFound`, `onEndpointConnected`, etc. |
| **`disconnectFromEndpoint`** | **NEW** — disconnect a single peer (was `disconnect()` on session) |
| **`stopAll`** | Combines stop-advertising + stop-discovery + disconnect-session |

**Status:** Source code ready; blocked on macOS/Xcode to build & test.

---

#### 1.7 — Test UI

**File rewritten:** `src/screens/app/NearbySpikeScreen.tsx`

| Feature | Detail |
|---|---|
| **Peer list** | FlatList showing all discovered + connected peers with state badges (FOUND / CONNECTING / CONNECTED / DISCONNECTED / RECONNECTING) |
| **CONNECT button** | Appears per peer in `Found` state — triggers `meshTransport.connect(endpointId)` |
| **DISCONNECT button** | Appears per peer in `Connected` or `Reconnecting` state — triggers `meshTransport.disconnect(endpointId)` |
| **ADVERTISE / DISCOVER** | Toggle buttons with active state indicator |
| **BROADCAST "hello"** | Sends base64 "hello world" to all connected peers |
| **STOP ALL** | Stops all advertising/discovery/connections |
| **Event log** | Scrollable live log with timestamps |
| **Payload progress bar** | Visual progress for in-progress payload transfers |
| **Alert on error** | `Alert.alert()` popup for any error, visible on-device without adb |
| **Diagnostic logging** | Every button press and callback logged via `logm`/`errm` to ReactNativeJS console (capturable via adb) |

**Route:** Expo Router `app/spike.tsx` → renders `NearbySpikeScreen` at `/spike`.

---

#### 1.8 — Diagnostic Logging System

**File created:** `src/utils/logger.ts`

| Function | Tag | Description |
|---|---|---|
| `logm(tag, msg, ...args)` | General | `console.log` with source tag prefix |
| `warnm(tag, msg, ...args)` | Warning | `console.warn` with source tag prefix |
| `errm(tag, msg, err?)` | Error | `console.error` with source tag prefix + stack trace |
| `logNativeCall(method, args, result?, error?)` | NativeCall | Structured logging for every native module call |

**Tags used:** `[MeshTransport]`, `[NearbyConnections]`, `[SpikeScreen]`, `[Permissions]`

**Capture workflow:**
```
adb -s <device> logcat -c                    # clear buffer
# (press button on device)
adb -s <device> logcat -s ReactNativeJS:V -d > logs/debug.log
```

**Output directory:** `packages/mobile/logs/` (gitignored)

---

#### 1.9 — Bugs Encountered & Fixed

| Bug | Root Cause | Fix |
|---|---|---|
| `SecurityException: requires FOREGROUND_SERVICE` | Missing `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_CONNECTED_DEVICE` permissions in `AndroidManifest.xml` | Added `<uses-permission>` declarations for both |
| `remoteEndpointIds cannot be empty` on broadcast | `sendPayloadToAll()` called with empty connected endpoints list | Added pre-check in `broadcast()` — throws clear "No peers connected" message |
| `NativeModules.NearbyConnections` null in bridgeless mode | Module uses legacy `ReactContextBaseJavaModule` pattern; not exposed automatically in new RN architecture | Added fallback stubs that throw clear diagnostic errors; module exposed through RN auto-linking |
| Discovery peer never appears in list | `subscribeToPlatformEvents()` only called in `discover()`, not `advertise()`; screen's `updatePeers()` queried only connected peers | Added `subscribeToPlatformEvents()` to `advertise()` with idempotency guard; changed `updatePeers()` to use `getAllPeers()` |
| Auto-connect on endpoint found (Phase 0 behavior) | Phase 0 auto-invoked `requestConnection` in `onEndpointFound` | Removed auto-connect; added explicit `connect(endpointId)` JS API |

---

#### Verification Results

```
[Advertiser] startAdvertising → OK
[Advertiser] onEndpointConnected("BZOI")          ← peer connected
[Advertiser] broadcast → 1 peer found → sent ✅
[Advertiser] onPayloadReceived ← hello back ✅

[Discoverer] startDiscovery → OK
[Discoverer] onEndpointFound("SYKX")              ← advertiser found
[Discoverer] connect → OK
[Discoverer] onEndpointConnected("SYKX")
[Discoverer] broadcast → 1 peer found → sent ✅
[Discoverer] onPayloadReceived ← hello back ✅

[Both] stopAll → clean
```

Both devices advertise, discover, connect, send, and receive bidirectionally. No crashes, no permission errors, no unhandled exceptions.

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
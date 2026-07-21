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

---

## Phase 3 — Security Layer (✅ Completed — 3-device relay encryption test pending)

**Goal:** Implement X25519 key exchange, XSalsa20-Poly1305 message encryption, and Ed25519 role credential verification for end-to-end encrypted mesh messaging.

### What changed
- **`src/crypto/KeyManager.ts`** — X25519 keypair generation via `tweetnacl`, private key persisted to `expo-secure-store`, SHA-512/32 fingerprint for display and QR-ready hex
- **`src/crypto/MessageCipher.ts`** — `encryptForPeer()` / `decryptFromPeer()` using `nacl.box.before` (X25519 DH) → shared secret → `nacl.secretbox` (XSalsa20-Poly1305); 24-byte random nonce per message
- **`src/crypto/KeyExchange.ts`** — TOFU (trust-on-first-use) peer key registry; `registerPeerKey()` stores base64 public key + hex fingerprint; `getPublicKey()` / `getFingerprint()` for shared secret derivation
- **`src/crypto/credentialIssuer.ts`** — `requestCredential()` calls Supabase Edge Function `sign-credential` to get Ed25519-signed role credentials; `verifyCredentialOffline()` verifies against baked-in server public key
- **`src/p2p/MessageRouter.ts` — encryption integration:**
  - `sendMessage()` / `sendToPeer()` now accept plaintext, encrypt internally per-peer
  - `handlePayloadReceived()` decrypts after dedup; relay nodes forward ciphertext without decrypting
  - `onPeerConnected()` sends public key as `ROLE_CREDENTIAL` envelope (key exchange)
  - `ROLE_CREDENTIAL` type messages are intercepted before routing — extract & register peer's public key
- **WatermelonDB changes:** schema version 2→3, new `peer_keys` table + `PeerKey` model + migration
- **`MeshEnvelope`** — added `sender_public_key` field so recipients can derive shared secret
- **`SecurityScreen.tsx`** — debug UI showing device fingerprint, known peers with padlock icons, legend
- **`MeshRoutingScreen.tsx`** — now passes plaintext directly (no manual `btoa`); per-peer padlock icon shows encryption status
- **`ProfileScreen.tsx`** — added buttons to navigate to MeshRouting screen and Security screen
- **Supabase Edge Function** — `supabase/functions/sign-credential/index.ts` for Ed25519-based role credential signing

### Dependencies added
| Package | Version | Purpose |
|---|---|---|
| `tweetnacl` | ^1.0.3 | X25519, XSalsa20-Poly1305, Ed25519 signature verification |
| `tweetnacl-util` | ^0.15.1 | Base64 + UTF-8 encode/decode helpers |
| `expo-secure-store` | ~14.0.0 | Private key storage in system keystore |
| `react-native-get-random-values` | latest | Polyfill `global.crypto.getRandomValues()` for TweetNaCl PRNG |

### Files created (8)
| File | Purpose |
|---|---|
| `src/crypto/KeyManager.ts` | Key generation, secure store, fingerprint |
| `src/crypto/MessageCipher.ts` | Encrypt/decrypt with nacl.secretbox |
| `src/crypto/KeyExchange.ts` | TOFU exchange, shared secret cache |
| `src/crypto/credentialIssuer.ts` | Supabase signing + offline verify |
| `src/crypto/index.ts` | Barrel exports |
| `src/screens/app/SecurityScreen.tsx` | Key fingerprint + peers security status |
| `src/db/models/PeerKey.ts` | WatermelonDB model for peer keys |
| `supabase/functions/sign-credential/index.ts` | Edge Function for credential signing |

### Files modified (13)
| File | Change |
|---|---|
| `package.json` | Added 4 dependencies |
| `src/nearby/types.ts` | Added `sender_public_key`, `PeerSecurityState` enum |
| `src/p2p/MessageEnvelope.ts` | `createEnvelope()` accepts `senderPublicKey` param |
| `src/p2p/MessageRouter.ts` | Full encryption integration, auto key exchange on connect |
| `src/p2p/index.ts` | Re-exports `keyManager`, `keyExchange` |
| `src/db/schema.ts` | v3 + `peer_keys` table |
| `src/db/migrations.ts` | v2→3 migration with `steps` API format |
| `src/db/models/index.ts` | Export PeerKey |
| `src/db/index.ts` | Register PeerKey + v3 migration |
| `src/screens/app/MeshRoutingScreen.tsx` | Plaintext API, padlock per peer |
| `src/screens/app/ProfileScreen.tsx` | Debug nav buttons |
| `src/utils/logger.ts` | Added ROUTER, DEDUP, KEYX, CRED, ROUTING, SECURITY tags |
| `app.config.js`, `.env.example` | Added `CREDENTIAL_PUBLIC_KEY` env var |

### Verification result
- **2-device key exchange** ✅ — devices exchange X25519 public keys on connect via `ROLE_CREDENTIAL` envelope; confirmed working in Phase 3 test pass
- **2-device encrypted messaging** ✅ — `sendMessage()` encrypts with per-peer shared key, receiver decrypts successfully; decrypted content visible in Routing Log
- **Relay forwarding** ⏳ — mathematically guaranteed (wrong shared key → `nacl.secretbox.open` returns null) but not yet physically verified with 3 devices
- **Role credential verification** ⏳ — code written but untested; requires deployed Supabase Edge Function + `CREDENTIAL_PUBLIC_KEY` env var

### Verification result
- **2-device key exchange** ✅ — devices exchange X25519 public keys on connect via `ROLE_CREDENTIAL` envelope; confirmed working in Phase 3 test pass
- **2-device encrypted messaging** ✅ — `sendMessage()` encrypts with per-peer shared key, receiver decrypts successfully; decrypted content visible in Routing Log
- **Relay forwarding** ⏳ — mathematically guaranteed (wrong shared key → `nacl.secretbox.open` returns null) but not yet physically verified with 3 devices
- **Role credential verification** ⏳ — code written but untested; requires deployed Supabase Edge Function + `CREDENTIAL_PUBLIC_KEY` env var

### Bugs fixed
1. **`expo-secure-store` version mismatch** — `57.0.1` (SDK 57) was incompatible with Expo SDK 54; pinned to `14.0.0` which provides `AnyTypeCache` matching bundled `expo-modules-kotlin`
2. **`no PRNG` crash** — React Native lacks `global.crypto`; added `react-native-get-random-values` polyfill at app root (`app/_layout.tsx` import) so `tweetnacl.randomBytes()` has a source of entropy. Initial fix (`import` in `KeyManager.ts`) didn't work due to Hermes bundler ordering; moved to root entry point resolved it. Requires full `npx expo run:android` build (dev client `a` key) for polyfill to take effect.
3. **`Collection.create() can only be called from inside of a Writer`** — WatermelonDB write operations (`persistMessage`, `persistPending`, `persistPeerKey`) in `MessageRouter.ts` called `.create()`/`.update()` outside of `database.write()`. Fixed by wrapping all three persist methods in `database.write(async () => { ... })`.
4. **Keys stored under deviceId but looked up by endpointId** — `handlePayloadReceived()` ROLE_CREDENTIAL handler called `keyExchange.registerPeerKey(env.sender_id, ...)` which stored the key under the logical deviceId (fingerprint). But `sendMessage()` looked up keys via `keyExchange.getPublicKey(peer.endpointId)` using Nearby's endpoint ID (e.g. `"KPPD"`). These never matched, so **every message was sent unencrypted** and decryption always failed — `subscribeDecrypted()` callbacks were never invoked. Fixed by adding `keyExchange.registerPeerKey(event.peerId, ...)` in both the ROLE_CREDENTIAL handler and the successful-decrypt path.

### Post-Phase-3 fixes applied
| Date | Fix |
|---|---|
| 2026-07-21 | `react-native-get-random-values` import moved to `app/_layout.tsx` root entry (Hermes compatibility) |
| 2026-07-21 | All three `persist*` methods in `MessageRouter.ts` wrapped in `database.write()` for WatermelonDB compliance |
| 2026-07-21 | Added `subscribeDecrypted()` callback to `MessageRouter` — decrypted messages now surfaced to UI |
| 2026-07-21 | `MeshRoutingScreen.tsx` subscribes to decrypted events and shows `[DECRYPTED from {senderId}: {text}]` in routing log |
| 2026-07-21 | Keys registered under BOTH `env.sender_id` (deviceId) AND `event.peerId` (endpointId) — fixes silent unencrypted-send bug |

### What's blocked
- 3-device relay encryption test — A→B→C: B receives but cannot decrypt (correct), C decrypts (needs third Android device)
- Role credential end-to-end — Edge Function not yet deployed; `CREDENTIAL_PUBLIC_KEY` not yet configured
- QR-pairing — deferred to Phase 10; fingerprints stored in hex format convertible to QR without migration

### Encryption architecture
```
sendMessage(type, plaintext)
  → encryptForPeer(plaintext, theirPub, ourSecret)
    → nacl.box.before(theirPub, ourSecret) → sharedKey
    → nacl.secretbox(plainBytes, nonce, sharedKey) → ciphertext
  → createEnvelope(sender_public_key, nonce, ciphertext)
  → transport.sendPayload(peer, serialized)

onPayloadReceived
  → deserializeEnvelope
  → if ROLE_CREDENTIAL → registerPeerKey(sender_id, ciphertext)
  → decryptFromPeer(ciphertext, nonce, senderPub, ourSecret)
    → nacl.box.before(senderPub, ourSecret) → sharedKey
    → nacl.secretbox.open(cipherBytes, nonceBytes, sharedKey) → plaintext | null
  → null → relay (forward TTL-1, cannot decrypt)
  → string → process locally
```

### Relevant paths
- `packages/mobile/src/crypto/` — all crypto modules (KeyManager, KeyExchange, MessageCipher, credentialIssuer)
- `packages/mobile/src/nearby/types.ts` — MeshEnvelope with sender_public_key
- `packages/mobile/src/p2p/MessageRouter.ts` — encryption integration
- `packages/mobile/src/db/schema.ts` — v3 + peer_keys table
- `packages/mobile/src/db/migrations.ts` — v2→3 migration
- `packages/mobile/src/screens/app/SecurityScreen.tsx` — encryption debug UI
- `packages/mobile/src/screens/app/MeshRoutingScreen.tsx` — routing + encryption test UI
- `packages/mobile/supabase/functions/sign-credential/index.ts` — Edge Function

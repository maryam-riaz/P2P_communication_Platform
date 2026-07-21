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

---

## Phase 4 — Chat (Text, Images) Over Mesh (✅ Completed)

**Goal:** Wire chat UI to mesh transport + routing + security layers. Implement chunked image transfer with reassembly. Persist all messages via WatermelonDB with conversation/thread model.

### What changed

#### DB Schema v3→v4 (3 new tables, 1 modified)
- **`media_chunks` modified** — added `file_name`, `mime_type`, `file_size` columns for cross-media-type support (image/video/audio all reuse same table)
- **`media_transfers`** — per-file transfer metadata: `record_id`, `message_id`, `file_name`, `mime_type`, `file_size`, `total_chunks`, `received_chunks`, `local_uri`, `status` (receiving/complete/failed)
- **`conversations`** — `conversation_id`, `last_message_preview`, `last_message_at`, `last_message_type`
- **`conversation_participants`** — `conversation_id`, `peer_id` (fingerprint), `peer_name`, `last_read_at` (for unread count). Lookup: find conversation where both self and peer are participants

#### 3 new WatermelonDB models
| Model | Key fields |
|---|---|
| `Conversation` | `conversationId`, `lastMessagePreview`, `lastMessageAt`, `lastMessageType` |
| `ConversationParticipant` | `conversationId`, `peerId`, `peerName`, `lastReadAt` |
| `MediaTransfer` | `recordId`, `messageId`, `fileName`, `mimeType`, `fileSize`, `totalChunks`, `receivedChunks`, `localUri`, `status` |

#### MeshEnvelope — `conversation_id` field added
- Added `conversation_id: string` to `MeshEnvelope` interface so sender embeds which conversation a message belongs to; relay nodes forward untouched; receiver uses it for DB persistence

#### ConversationManager (`src/p2p/ConversationManager.ts`)
- `getOrCreateConversation(conversationId, peerId, peerName)` — auto-creates conversation + participant records on first message
- `lookupConversationByPeer(peerId)` — finds existing conversation by scanning participants table
- `updateLastMessage(conversationId, preview, type)` — updates conversation metadata on each send/receive
- `getUnreadCount(conversationId, peerId)` / `markRead(conversationId, peerId)` — unread tracking
- `observeConversations()` / `observeMessages(conversationId)` — WatermelonDB reactive observables for UI

#### Chunked Image Transfer Pipeline

**`ImageChunker.ts`** — `chunkFile(uri, chunkSize=128KB)`:
- Reads file as base64 via `expo-file-system`
- Splits into N chunks of specified size
- Returns `{ chunks, totalChunks, fileId, fileSize }`

**`ImageSender.ts`** — `sendImage(endpointId, uri, name, conversationId, mimeType, onProgress)`:
- Calls `chunkFile()` → sends each chunk via `messageRouter.sendToPeer()` with `type: 'IMAGE'`, `chunkIndex`, `chunkTotal`
- Reports progress per-chunk via callback

**`ChunkAssembler.ts`** — `receiveChunk()` / `reassemble()`:
- Stores each chunk in `media_chunks` table
- Upserts `media_transfers` row, increments `received_chunks`
- When `received_chunks === total_chunks`: concatenates base64, writes to `FileSystem.cacheDirectory/mesh-images/` via `writeBase64ToCache()`, updates `media_transfer` status to `'complete'`, creates `messages` record with `localUri` as payload
- Subscribable progress (`subscribeChunkProgress`) and completion (`subscribeImageComplete`) callbacks

**`mediaCache.ts`** — filesystem cache helpers: `ensureCacheDir()`, `writeBase64ToCache()`, `readFileAsBase64()`, `evictOldImages()`

#### MessageRouter updates
- `sendMessage()` / `sendToPeer()` — added `chunkIndex`, `chunkTotal`, `conversationId` to opts; all forwarded to `createEnvelope()`
- `handlePayloadReceived()` — if `env.type === 'IMAGE'`, forwards decrypted chunk to `ChunkAssembler.receiveChunk()` instead of treating as text
- `subscribeDecrypted()` callback signature now includes optional `conversationId` parameter
- `persistMessage()` uses `env.conversation_id` (falls back to `env.message_id`)

#### ChatListScreen — wired to real data
- Replaces `MOCK_CONVERSATIONS` with WatermelonDB query on `conversations` table
- "Discovered Peers Nearby" section shows live peers from `meshTransport.getAllPeers()`
- Online/offline status from `meshTransport.getConnectedPeers()`
- Real-time refresh via mesh transport event subscriptions (`onPeerFound`, `onPeerLost`, on connect/disconnect)
- Navigates to Chat with `conversationId`, `endpointId`, `peerId`, `recipientName`

#### ChatScreen — wired to mesh + image transfer
- Messages loaded from DB via `database.get<Message>('messages').observe()` filtered by `conversationId`
- **Send text:** `handleSendMessage()` → `messageRouter.ensureConversation()` then `messageRouter.sendToPeer()` (persists plaintext internally as `pending`) → status updated `pending`→`sent`/`failed` by querying conversation messages
- **Receive text:** `handlePayloadReceived()` persists message + auto-creates Conversation/Participant records; `subscribeDecrypted()` is now log-only (no duplicate DB write)
- **Send image:** `handlePickAttachment()`/`handleLaunchCamera()` for images → `ImageSender.sendImage()` → chunked send with progress bar
- **Receive image:** `subscribeChunkProgress()` updates progress bar; `subscribeImageComplete()` creates `messages` record with `localUri` + `messageRouter.updateConversationPreview()`
- **Voice recording, camera, attachment picker, audio/video playback, image preview modal** — preserved from existing UI
- Peer active status checked periodically via `meshTransport.getConnectedPeers()`

#### Navigation cleanup
- Removed unused duplicate `ChatStack` component from `AppStack.tsx`

#### Post-Phase-4 bug fixes (2026-07-21)
| Bug | Root Cause | Fix |
|---|---|---|
| 3 messages per send | ChatScreen initial `database.write()` + `sendToPeer()`'s `persistMessage()` + flood-relay from peer created 3 DB records per send | Removed ChatScreen's initial write; `sendToPeer()` stores plaintext (not ciphertext); added `dedup.add(env.message_id)` before send so relay-back is deduped; `subscribeDecrypted()` no longer persists to DB |
| Received messages invisible in chat list | `handlePayloadReceived()` never created Conversation/ConversationParticipant records — only the `messages` row existed | Added `conversationManager.getOrCreateConversation()` and `updatePeerName()` in `handlePayloadReceived()` after successful decrypt; sender also calls `ensureConversation()` before `sendToPeer()` |
| Peer display name not exchanged | `MeshEnvelope` had no `display_name` field; ROLE_CREDENTIAL carried only the public key | Added `display_name` to `MeshEnvelope` + `createEnvelope()` opts; `handlePeerConnected()` passes `this.displayName`; `handlePayloadReceived()` stores names in `peerNames` map; `AppStack.tsx` syncs Redux `state.auth.user` → `messageRouter.setDisplayName()` |

### Dependencies added
| Package | Version | Purpose |
|---|---|---|
| `expo-file-system` | ~18.0.0 | Read image files, write reassembled images to cache |

### Files created (8)
| File | Purpose |
|---|---|
| `src/db/models/Conversation.ts` | WatermelonDB model |
| `src/db/models/ConversationParticipant.ts` | WatermelonDB model |
| `src/db/models/MediaTransfer.ts` | WatermelonDB model |
| `src/p2p/ConversationManager.ts` | Conversation lifecycle + observe helpers |
| `src/p2p/ImageChunker.ts` | Split image file into base64 chunks |
| `src/p2p/ImageSender.ts` | Send chunked image over mesh + progress |
| `src/p2p/ChunkAssembler.ts` | Accumulate/reassemble received chunks |
| `src/utils/mediaCache.ts` | Filesystem cache helpers |

### Files modified (12)
| File | Change |
|---|---|
| `src/nearby/types.ts` | Added `conversation_id`, `display_name` to MeshEnvelope |
| `src/p2p/MessageEnvelope.ts` | Accept `conversationId`, `displayName` in `createEnvelope()` |
| `src/p2p/MessageRouter.ts` | IMAGE type handling, chunk progress, conversation_id/display_name pass-through, dedup on send, plaintext persist, auto-create conversations on receive, peer name exchange |
| `src/p2p/conversationManager.ts` | Added `updatePeerName()` method |
| `src/p2p/index.ts` | Export new managers |
| `src/db/schema.ts` | v4: 3 new tables + 3 columns on media_chunks |
| `src/db/migrations.ts` | v3→v4 migration (addColumns + 3 createTable) |
| `src/db/models/MediaChunk.ts` | Added file_name, mime_type, file_size fields |
| `src/db/models/index.ts` | Export 3 new models |
| `src/db/index.ts` | Register 3 new models + v4 migration |
| `src/navigation/AppStack.tsx` | Remove dead ChatStack; sync Redux `state.auth.user` → `messageRouter.setDisplayName()` |
| `src/screens/app/ChatScreen.tsx` | Mesh send/receive, chunked image progress; removed duplicate DB writes; removed subscribeDecrypted persistence |
| `package.json` | Added expo-file-system |

### Test plan
| Test | Verification |
|---|---|---|
| 2-device text chat | A→B send/receive visible in chat bubbles with correct sender labels |
| 2-device image transfer | A sends photo → progress bar on both sides → full image on recipient |
| Conversation persistence | Close + reopen app → conversations + messages restored |
| Unread badges | New message from peer → badge on conversation list |
| 3-device relayed text | A→B→C: B relays ciphertext, C decrypts + displays |
| 3-device relayed image | A→B→C: B relays each ciphertext chunk, C reassembles |
| Offline queue | Send while peer disconnected → message queued → flushed on reconnect |

### Post-Phase-4 bug fixes (second round — 2026-07-21)
| Bug | Root Cause | Fix |
|---|---|---|
| Messages show "pending" / not received (existing conversations) | `ChatListScreen.openConversation` passed fingerprint as `endpointId`, but `sendToPeer` needs Nearby endpoint ID | `sendToPeer` resolves fingerprint → endpointId via `PeerSession` map |
| Messages invisible on receiver side | `openChat` always generated new `conversationId` even when conversation for peer existed | Added `getPeerSession` lookup; no duplicate conversations |
| Display name shows package name / blank | `advertise()` called with no `deviceName`; nearby list used raw `PeerInfo.displayName` not exchanged username | `MeshRoutingScreen` passes `deviceName: messageRouter.getDisplayName()`; nearby list uses `PeerSession.displayName` |
| Stale endpointId across reconnections | No reverse mapping from fingerprint to endpointId | `endpointToFingerprint` index, torn down on disconnect |
| Sent messages stay "pending" on sender | `sendToPeer()` never updated status after successful send | Removed ChatScreen compensation; IMAGE skips persistMessage; TEXT status updates in sendToPeer |
| Image chunks show as blank/black on sender | Each chunk created a separate `messages` record with base64 payloads | `sendToPeer()` skips `persistMessage()` for IMAGE; `ImageSender` creates single record with `payload=imageUri` |
| Image not received/reassembled on receiver | Each chunk had unique `message_id` so `ChunkAssembler` couldn't group them | `sendToPeer()` accepts `messageId` opt; `ImageSender` passes shared `fileId` as `messageId`; dedup skipped for IMAGE |
| Unread count never decrements | Counted all messages without `lastReadAt` filter; `ChatScreen` never called `markRead()` | Added `lastReadAt` filter; `useFocusEffect` calls `markConversationRead()` |
| Android bundling failed — `'return' outside of function` at ChatScreen.tsx:765 | Orphaned duplicate `setTimeout` + `};` left behind from `sendImageMessage` edit | Deleted orphaned lines 310-317 that prematurely closed the component scope |
| Text not received at the other end | `persistMessage` wrote with `env.conversation_id` (sender's ID) but receiver's ChatScreen queries its own local conversation ID | Set `env.conversation_id = convId` before `persistMessage` so message is stored under receiver's local conversation |
| Images duplicated and blank/black on receiver | (a) IMAGE type skipped dedup entirely — each relayed copy of every chunk was re-processed, amplified by flood relay until TTL exhausted. (b) Parallel `receiveChunk` calls all saw `allChunks.length >= chunkTotal` and each triggered `reassemble`, creating 10× messages. Some fired before all chunks arrived → invalid base64 | (a) IMAGE dedup uses composite key `messageId + chunkIndex` so each duplicate chunk is rejected. (b) Duplicate chunk guard in `receiveChunk` — skip if same `recordId`+`chunkIndex` already exists. (c) Reassembly guard — `reassembled Set` ensures `reassemble` fires only once per `recordId` |
| Sent text not received by the other device | `ChatScreen.handleSendMessage()` used stale `endpointId` from navigation params; peer reconnection (disconnect + new Nearby endpoint ID) leaves the old endpointId in the route, but `sendToPeer`'s resolution only handled fingerprint→endpointId lookup, not stale endpointId→current endpointId | Added `MessageRouter.resolveEndpointId()` that checks 3 maps in order: `endpointToFingerprint` (current), `peerSessions` by fingerprint, and new `staleEndpointToFingerprint` (preserved across disconnects). `handlePeerDisconnected` saves stale mapping; `handlePayloadReceived` clears it on reconnect. `ChatScreen.handleSendMessage()` calls `resolveEndpointId()` before each send. |
| Sent text stays "pending" on sender | `sendToPeer()` persisted message with `status='pending'` but never updated to `'sent'` after `sendPayload` succeeded. Only `ImageSender` had its own compensation. | `persistMessage()` returns the created record's WatermelonDB `id`. `sendToPeer()` stores `pendingRecordId`, then calls new `updateMessageStatus(pendingRecordId, 'sent')` after successful `sendPayload`. |
| Multiple blank images after actual image | (a) `subscribeImageComplete` callback used fire-and-forget `.then()` chain — if it fired twice (React strict-mode or `useEffect` re-registration), multiple `messages` records created. Incomplete base64 from races produced blank images. (b) `receiveChunk` checked `allChunks.length >= chunkTotal` which could pass with duplicate chunk indices | (a) Callback is now `async` with `await`, has `completedRecords` Set guard and DB-level dedup query before creating a record. (b) `receiveChunk` checks `uniqueIndices.size >= chunkTotal` (unique indices via Set) instead of raw `allChunks.length` |

### Architecture: PeerSession
- **Creation:** `handlePayloadReceived` ROLE_CREDENTIAL branch — session populated at verified handshake
- **Teardown:** `handlePeerDisconnected` — session deleted, subscribers notified with cleared endpointId
- **Observable:** `subscribePeerSession(cb)` — fires on create/update/delete
- **endpointToFingerprint** reverse index handles reconnection (new endpointId → same fingerprint)

### Post-Phase-4 bug fixes (third round — 2026-07-22)
| Bug | Root Cause | Fix |
|---|---|---|
| Sender's last sent message stays "pending" despite being received | `updateMessageStatus()` was inside `sendPayload`'s try-catch block. If status update threw (DB write conflict), the catch block silently swallowed it, logged a misleading "failed" message, and queued a pending message — even though the payload was sent successfully. | Moved `updateMessageStatus()` outside the `sendPayload` try-catch so a successful send always results in a status update. Added `return env` in the catch block on failure so status update never runs for failed sends. |
| Relay loops cause blank images on sender's chat | (a) IMAGE dedup was skipped entirely during `sendToPeer()` — relayed copies from receiver were not recognized as duplicates. Sender's `handlePayloadReceived` would receive its own relayed chunks, fail to decrypt (encrypted for receiver), and call `persistMessage(env, 'received', ciphertext)` — creating a message record with `type='image'` and `payload=ciphertext`. The ChatScreen observer rendered each as `<Image uri={ciphertext}>`, showing blank images. For a 29-chunk image, this created 29 blank images. (b) Undecryptable messages (relayed by flood routing) were persisted to the main `messages` table with the original type preserved, creating phantom visible records. | (a) IMAGE dedup now uses composite key `messageId_chunkIndex` during send instead of being skipped entirely. (b) Removed `persistMessage()` call in the undecryptable branch of `handlePayloadReceived()` — relay nodes no longer create visible message records for traffic they forward. Messages are still persisted to `pending_messages` for store-carry-forward. |
| `sendMessage()` (broadcast) never updated status to 'sent' | The broadcast method persisted messages with `status='pending'` but never called `updateMessageStatus()` after sending. | Added `updateMessageStatus(recordId, 'sent')` in the `sendMessage()` persist loop. |
| ImageSender fragile status query | `ImageSender.sendImage()` queried ALL messages and filtered in-memory by `payload + status` to find the sender's record to update to 'sent'. This was fragile with concurrent sends and could match the wrong record. | Captures WatermelonDB record ID at creation time, uses `find(id)` + `update()` directly. |

### Known issues
- **Last sent message still shows "pending" despite being received** — The fix above (moving `updateMessageStatus` outside the catch block) addresses a code-path bug, but the user reports the issue persists specifically for the **last** message in a session. This suggests a timing/lifecycle issue where the final `database.write()` for the status update may not complete or the observer may not fire before the component state stabilizes. Debugging logging was added to `updateMessageStatus()` to confirm whether the function executes. New logcat output is needed to diagnose further.

### Relevant paths
- `packages/mobile/src/db/schema.ts` — v4 schema
- `packages/mobile/src/db/migrations.ts` — v3→v4 migration
- `packages/mobile/src/db/models/Conversation.ts` — Conversation model
- `packages/mobile/src/db/models/ConversationParticipant.ts` — Participant model
- `packages/mobile/src/db/models/MediaTransfer.ts` — Media transfer tracking
- `packages/mobile/src/db/models/MediaChunk.ts` — Updated with file metadata
- `packages/mobile/src/p2p/ConversationManager.ts` — Conversation lifecycle
- `packages/mobile/src/p2p/ImageChunker.ts` — File chunking
- `packages/mobile/src/p2p/ImageSender.ts` — Chunked image send
- `packages/mobile/src/p2p/ChunkAssembler.ts` — Chunk receive + reassembly
- `packages/mobile/src/utils/mediaCache.ts` — Filesystem cache
- `packages/mobile/src/p2p/MessageRouter.ts` — IMAGE type handling, PeerSession, endpoint resolution, messageId opt, markConversationRead
- `packages/mobile/src/nearby/types.ts` — MeshEnvelope with conversation_id
- `packages/mobile/src/screens/app/ChatListScreen.tsx` — Real chat list, PeerSession lookup, unread fix, PeerSession displayName for nearby
- `packages/mobile/src/screens/app/ChatScreen.tsx` — Mesh-wired chat, reactive displayName, markConversationRead on focus
- `packages/mobile/src/navigation/AppStack.tsx` — Cleaned up navigation
- `packages/mobile/src/p2p/ConversationManager.ts` — Conversation lifecycle with updatePeerName
- `packages/mobile/src/p2p/index.ts` — Re-exports PeerSession
- `packages/mobile/src/screens/app/MeshRoutingScreen.tsx` — Passes deviceName to advertise()
- `packages/mobile/src/utils/mediaCache.ts` — Legacy expo-file-system import

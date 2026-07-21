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

### Phase 0 — Foundations & Spike (1–2 weeks)
- Confirm the existing UI-only Expo skeleton builds and runs (already done).
- Set up WatermelonDB schema skeleton (users, messages, sos_reports, media_chunks, sync_outbox tables).
- Set up Supabase project: Postgres schema, Auth, Storage buckets, RLS policies stubbed for `user`/`rescuer`/`admin`.
- **Spike:** build the smallest possible native module proving two Android devices can discover and exchange a byte payload via Nearby Connections, with no UI. Do the same for two iOS devices via Multipeer Connectivity. This is the highest-risk unknown in the whole project — validate it first.
- Deliverable: two phones exchange "hello world" bytes with no internet, on each platform independently.

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
| Native mesh modules are the single largest unknown/effort sink | De-risked first via Phase 0 spike before any feature work |
| Multi-hop routing reliability under real-world device churn | Dedicated Phase 2 with physical multi-device chain testing, not just simulator/two-device testing |
| Video transfer speed over BLE/Wi-Fi Direct mesh | Addressed via compression + chunking + resumable transfer, not by dropping encryption |
| Cross-platform (Android↔iOS) direct P2P has real limitations without a shared Wi-Fi AP | Scope realistic expectations early; may need same-platform assumption for true multi-hop in v1, with cross-platform as a stretch goal |
| Battery drain from constant advertising/discovery | Tuned duty cycles, addressed explicitly in Phase 10 |
| Role credential compromise | Bounded expiry + opportunistic refresh, not indefinite trust |
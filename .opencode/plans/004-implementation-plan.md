# Implementation Plan: Bug 1 & Bug 2 Fixes

**Date:** 2026-07-19
**Priority:** Bug 2 (Wi-Fi Direct Deadlock) > Bug 1 (BLE Scanner)

---

## Bug 2 — Wi-Fi Direct Initiator Deadlock (Priority: CRITICAL)

### Problem

Both devices compute `isInitiator = false`, so neither calls `connectToPeer()`. Connection never established.

**Root cause — two broken paths:**

1. **BLE map path (Tier 1, lines 751-784):** Never works. The BLE advertiser sets `setIncludeDeviceName(false)` in `BleAdvertiserModule.kt`, so `peerDevice.name` is always `undefined`. The `if (peerDevice.name)` guard at line 911 skips `bleDiscoveredIds` population entirely. The map is always empty.

2. **Name fallback path (Tier 2, lines 786-802):** Deadlocks because Wi-Fi Direct names are OS-assigned (e.g. `"Maryam's A32"`, `"Android_b3:4c:f5"`) and don't correspond to app display names (e.g. `"talha"`, `"maryam"`). Lexicographic comparison produces `false` on both sides:
   - Talha's device: `"talha" < "maryam"` → `false` (t > m)
   - Maryam's device: `"maryam" < "android"` → `false` (m > a)

### Solution

**Remove the initiator check entirely.** Both devices always attempt connection when they discover available Wi-Fi Direct peers. Wi-Fi Direct OS-level negotiation handles GO/client role assignment.

### Why this is safe

- `isAlreadyConnectedOrConnecting` (lines 713-727) prevents re-connecting to already-connected peers by checking MAC address, connection key, and fuzzy display name match
- `connectingKeys` set prevents re-triggering during an in-progress connection
- `groupRole === 'client'` guard (line 708) prevents clients from connecting out to a second peer (real Wi-Fi Direct constraint)
- Wi-Fi Direct OS handles simultaneous `connect()` calls — one device becomes GO, one becomes client
- Existing polling fallback (lines 819-843) and error handling (lines 844-856) remain unchanged

### File to modify

`packages/mobile/src/hooks/useInitializeServices.ts`

### Changes

**Replace lines 744-808** (entire initiator selection loop + early return) with:

```typescript
// No initiator check — both devices attempt connection.
// Wi-Fi Direct OS negotiation handles GO/client role assignment.
// The isAlreadyConnectedOrConnecting filter above prevents duplicates.
candidateToConnect = candidates[0];
console.log(`[P2P DEBUG] Connecting to candidate '${candidateToConnect.deviceName}' (${candidateToConnect.deviceAddress}). OS handles role negotiation.`);
```

### What NOT to change

| Code | Lines | Why keep it |
|------|-------|-------------|
| `bleDiscoveredIds` population | 910-917 | Used for fast-reconnect (line 427) and periodic retry (line 944) |
| `isAlreadyConnectedOrConnecting` | 713-727 | Prevents duplicate connections |
| `connectToPeer` call + polling | 810-856 | Connection flow unchanged |
| Periodic retry timer | 942-955 | Re-triggers discovery when BLE peers known but no group formed |
| `groupRole === 'client'` guard | 708 | Prevents clients from connecting out |

### Verification

1. `pnpm --filter mobile exec tsc --noEmit` — no type errors
2. Two-device test: both discover via BLE → both appear in Wi-Fi Direct peer list → at least one calls `connectToPeer()` → group forms (one GO, one client) → TCP + ECDH handshake succeeds
3. Three+ device test: multiple connections work
4. Disconnection/reconnection: fast-reconnect still works via `bleDiscoveredIds`

---

## Bug 1 — BLE Scanner Never Sees Extended Advertisements (Priority: HIGH)

### Problem

1. `legacy: true` in `ble-scanner.ts:317` tells the scanner to only accept BLE 4.x legacy advertisements. The advertiser uses BLE 5.0 extended mode (`setLegacyMode(false)` in `BleAdvertiserModule.kt:166`). Scanner never sees our ads.

2. Manufacturer data key changed from hex `"ffff"` to decimal `"65535"`. Android source (`DefaultPeripheral.java`) uses `String.format("%04x", key)` — hex format. `"ffff"` was correct.

### File to modify

`packages/mobile/src/comms/ble/ble-scanner.ts`

### Changes

1. **Line 317:** Change `legacy: true` → `legacy: false`
2. **Line 135:** Change `"65535"` → `"ffff"` (revert to hex format)

### Verification

1. `pnpm --filter mobile exec tsc --noEmit` — no type errors
2. BLE scan should now see SOSIFY advertisements (magic prefix `0xD2 0x50`)
3. `bleDiscoveredIds` map should populate (once Bug 2 fix + name field is addressed)

---

## Implementation Order

1. Bug 2 first (deadlock is deployment-blocking)
2. Bug 1 second (scanner fix enables end-to-end BLE → Wi-Fi Direct flow)

## Risks

| Risk | Mitigation |
|------|------------|
| Both devices call `connect()` simultaneously | Wi-Fi Direct OS handles this — arbitrates GO/client. Dedup layers prevent re-connection within a device. |
| `candidateToConnect = candidates[0]` may pick wrong peer in multi-peer scenario | Acceptable for now — any connection is better than no connection. Can refine later with UUID-based selection. |
| `bleDiscoveredIds` still never populates (name is undefined) | Not a regression — it was already empty. Fast-reconnect falls back to full cleanup. Can be fixed separately by including device_id in BLE ad payload or Wi-Fi Direct name. |

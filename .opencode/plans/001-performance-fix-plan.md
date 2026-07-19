# Performance Fix Implementation Plan

**Date:** 2026-07-19
**Scope:** 5 performance issues — UI freeze, DB blocking, keyboard lag, BLE byte mismatches, TCP reconnection delays
**Out of scope:** Multi-hop mesh routing (notes below for future compatibility)
**Targets:** Launch < 4s, keyboard response < 100ms, reconnection < 5s, physical-device testing only

---

## Phase 1: BLE Comment/Test Cleanup (Issue 4)

**Why first:** Zero runtime risk. Builds confidence. Eliminates misleading documentation before touching runtime code.

### Root Cause
Stale comments from a removed `timestamp` field claim payloads are 27/23 bytes. Actual sizes are 23/21. A test file has out-of-bounds DataView reads that would crash at runtime.

### Fix Approach

| File | Change |
|------|--------|
| `ble-advertiser.ts:30` | Change "27 bytes" -> "23 bytes" |
| `ble-advertiser.ts:67` | Change "23 bytes" -> "21 bytes" |
| `ble-advertiser.ts:70` | Fix packet budget: `3+1+1+2+21 = 28/31 bytes (3 byte margin)` |
| `ble-scanner.ts:32` | Change "27-byte" -> "23-byte" |
| `ble-scanner.ts:53` | Change "23-byte" -> "21-byte" |
| `__tests__/transport.test.ts:107` | Remove stale 4th `timestamp` arg from `packFullPayload` call |
| `__tests__/transport.test.ts:127-129` | Remove out-of-bounds DataView read assertion |
| `__tests__/transport.test.ts:138` | Remove stale 4th `timestamp` arg from `packTrimmedPayload` call |
| `__tests__/transport.test.ts:140` | Fix comment: "23 bytes" -> "21 bytes" |

### Test Criteria
- `pnpm --filter mobile exec jest` passes with no failures
- No runtime behavior changes

### STOP CHECKPOINT
- [ ] All tests pass
- [ ] No production code changed (only comments + test assertions)

---

## Phase 2: Database Layer Optimizations (Issue 2)

**Why second:** Foundational — UI fixes in Phase 3 depend on stable observable pipelines.

### Root Cause
Multiple patterns cause unnecessary main-thread blocking: reads inside write locks, unbatched individual updates, heavy observable pipelines, unbounded queries, and unbounded table growth.

### Fix Approach

#### 2A: Move read outside write lock in `addNewPeer`
**File:** `repository.ts:71-75`
```
Current:  db.write(() => { query().fetch(); update/create })
Fixed:    query().fetch(); db.write(() => { update/create })
```
The dedup query at line 72-75 must execute before acquiring the write lock. This is safe because the final insert/update is still atomic inside `db.write()`.

#### 2B: Batch `markAsRead` updates
**File:** `ChatService.ts:383-389`
```
Current:  db.write(() => { for msg: msg.update(record => { ... }) })
Fixed:    Batch all record IDs, use a single raw SQL UPDATE or batch WatermelonDB calls
```
Replace the loop of individual `msg.update()` calls with a single bulk operation. WatermelonDB supports calling `msg.update()` on multiple records within one `db.write()` — the key optimization is avoiding per-record setup overhead.

#### 2C: Optimize `observeConversations()` pipeline
**File:** `ChatService.ts:289-369`
1. Add `distinctUntilChanged` after `observeWithColumns` comparing array length, message IDs, and sync_statuses
2. Cache `getLocalDeviceId()` result (already has `cachedLocalDeviceId` at line 274 — ensure it's used)
3. Replace `peers.find()` O(n) lookup at line 329 with a `Map` constructed from the `partners` array
4. Add `debounceTime(100)` to prevent rapid re-emissions during message bursts

#### 2D: Add `Q.take()` limits to unbounded queries
| Query | File:Line | Add limit |
|-------|-----------|-----------|
| `getMessagesByRecipient` | `repository.ts:133-138` | `Q.take(200)` |
| `getSosEvents` | `repository.ts:212-214` | `Q.take(50)` |
| `getPendingSyncItems` | `repository.ts:255-260` | `Q.take(100)` |
| `retryPendingMessages` | `ChatService.ts:784-791` | `Q.take(50)` |

#### 2E: Add `location_log` cleanup + timestamp index
**File:** `schema.ts` — Bump version to 4, add migration:
```typescript
{ name: 'timestamp', type: 'number', isIndexed: true }
```
**File:** `repository.ts` — Add method:
```typescript
async cleanupOldLocations(maxAgeMs: number): Promise<void>
```
**File:** `MapService.ts` — Call cleanup on each `handleLocationUpdate` (keep last 1 hour = ~360 rows max)

#### 2F: Enable LokiJS web worker (dev/test only)
**File:** `useInitializeServices.ts:72-73`
```typescript
useWebWorker: true,
useIncrementalIndexedDB: true,
```
**Note:** This only affects Expo Go / test environments. Production native builds use SQLite adapter and are unaffected.

#### 2G: Remove dead code in SosService
**File:** `SosService.ts:68` — Remove unused `const peers = await this.db.get<KnownPeer>('known_peers').query().fetch();`

### Test Criteria
- `pnpm --filter mobile exec jest` passes
- `pnpm --filter mobile exec tsc --noEmit` passes
- Manual test: open conversation with 50+ messages, verify no jank on scroll
- Manual test: navigate in/out of ChatScreen, verify markAsRead doesn't cause visible lag

### STOP CHECKPOINT
- [ ] All tests pass
- [ ] TypeScript compiles
- [ ] WatermelonDB migration version bumped to 4
- [ ] `location_log` table has timestamp index
- [ ] observeConversations emission rate measurably reduced in dev tools

---

## Phase 3: Chat UI & Keyboard Responsiveness (Issue 3)

**Why third:** Depends on Phase 2's observable optimizations being stable.

### Root Cause
Every `sync_status` change across the *entire* messages table triggers a full re-render of ChatScreen: 50 `JSON.parse` calls, array copy + reverse + map, triple `scrollToEnd`, and re-renders from global transport status subscriptions.

### Fix Approach

#### 3A: Add `distinctUntilChanged` to message observable
**File:** `ChatService.ts:271`
```typescript
// Before:
.observeWithColumns(['sync_status'])
// After:
.observeWithColumns(['sync_status']),
distinctUntilChanged((prev, curr) => {
  if (prev.length !== curr.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i].id !== curr[i].id) return false;
    if ((prev[i]._raw as any).sync_status !== (curr[i]._raw as any).sync_status) return false;
  }
  return true;
})
```

#### 3B: Memoize `toDisplayMessage` results
**File:** `ChatScreen.tsx:46-72`
Use a `useRef<Map<string, DisplayMessage>>` cache. Only re-parse messages whose `_raw` has changed. The cache key is `msg.id + msg._raw.sync_status`.

#### 3C: Remove duplicate `scrollToEnd` calls
**File:** `ChatScreen.tsx`
- **Remove** line 191: `setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100)`
- **Keep** line 790: `onContentSizeChange` scrollToEnd (only fires when content actually changes)
- Add a guard: only scrollToEnd if the user was already near the bottom (within 200px)

#### 3D: Replace keyboard state with `useRef` + native driver
**File:** `ChatScreen.tsx:78-96`
```typescript
// Before:
const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
// After:
const keyboardPaddingRef = useRef(0);
const inputWrapperRef = useRef<View>(null);
// Use Keyboard.addListener to directly animate the padding via UIManager
```
This avoids a full component re-render on every keyboard show/hide.

#### 3E: Add FlatList performance props
**File:** `ChatScreen.tsx:782-791`
```typescript
<FlatList
  // ...existing props
  getItemLayout={(_, index) => ({
    length: ITEM_HEIGHT,
    offset: ITEM_HEIGHT * index,
    index,
  })}
  windowSize={7}
  maxToRenderPerBatch={10}
  updateCellsBatchingPeriod={50}
  initialNumToRender={15}
  removeClippedSubviews={Platform.OS === 'android'}
/>
```

#### 3F: Throttle `observeActiveTransportIds` in ChatListScreen
**File:** `ChatListScreen.tsx:69-77`
Add `throttleTime(1000)` to the subscription to prevent re-rendering on rapid transport connect/disconnect.

#### 3G: Add `React.memo` to `renderMessageItem`
**File:** `ChatScreen.tsx:678`
Wrap the `renderMessageItem` component with `React.memo` and compare by `item.id + item.status + item.text`.

### Test Criteria
- Open keyboard in ChatScreen: first character appears within 100ms of keypress (measure via React DevTools profiler)
- Send a message: message bubble appears instantly, no jank
- Switch between conversations rapidly: no visible stutter
- FlatList scroll performance: 60fps during rapid scroll through 50 messages
- `pnpm --filter mobile exec tsc --noEmit` passes

### STOP CHECKPOINT
- [ ] Keyboard opens and accepts input within 100ms
- [ ] Sending a message: bubble renders in < 100ms
- [ ] React DevTools profiler shows no unnecessary re-renders during idle
- [ ] Scroll through 50 messages: no frame drops
- [ ] TypeScript compiles

---

## Phase 4: Startup Decoupling + TCP Reconnection (Issues 1 & 5)

**Why last:** Most invasive change. Depends on all other phases being stable. Issues 1 and 5 are tightly coupled — shared `useInitializeServices.ts`, shared `performP2PCleanup`, shared transport lifecycle.

### Root Cause
`setServices()` (and therefore all UI rendering) is blocked until P2P transports fully initialize, including a 120-second `firstPeerIpPromise`. TCP reconnection has stuck states (`serverSocketBound`, `groupRole`) and triple redundant retry systems.

### Fix Approach

#### 4A: Decouple transport init from `setServices()` (Issue 1)
**File:** `useInitializeServices.ts:959-973`

**Before (current):**
```
initAsync():
  create DB
  create services
  IF existingUser:
    await initTransportsForUser(existingUser)  // BLOCKS for up to 120s
  setServices({...})  // UI only shows after this
```

**After (fixed):**
```
initAsync():
  create DB
  create services
  setServices({...})  // UI SHOWS IMMEDIATELY
  IF existingUser:
    initTransportsForUser(existingUser)  // NO await — runs in background
      .catch(err => console.warn(...))
```

The `initTransportsForUser` function already stores its state in closure-scoped variables (`connectionsByKey`, `groupRole`, etc.) and returns `shutdownTransports` via the services object. The UI components that depend on transport state (ChatScreen's `isPeerActive`, ChatListScreen's `onlinePeerIds`) subscribe to observables that update as transports connect — no blocking required.

#### 4B: Remove `firstPeerIpPromise` from critical path (Issue 1)
**File:** `useInitializeServices.ts:909-922`
Remove the `await firstPeerIpPromise` and its associated `firstPeerIpTimeout`. The promise was only used to gate `setServices()`, which we've already decoupled. The Wi-Fi Direct group formation continues to work via the `handleConnectionInfo` event handler.

#### 4C: Optimize `performP2PCleanup` (Issues 1 & 5 — shared change)
**File:** `useInitializeServices.ts:148-187`

| Current | Fixed | Savings |
|---------|-------|---------|
| `await setTimeout(500)` after `cancelConnect` | Replace with `await getConnectionInfo()` state check (poll up to 3x, 100ms apart) | ~400ms |
| `await setTimeout(500)` after `clearPersistentGroups` | Remove entirely (fire-and-forget) | 500ms |
| `removeGroup()` retry: 3 attempts, 600ms apart | 2 attempts, 300ms apart | ~900ms |
| **Total savings** | | **~1.8s** |

**Critical:** Do NOT remove all delays blindly — the native `WifiP2pManager` processes state transitions asynchronously. Replace with state-verification polls.

#### 4D: Fix `serverSocketBound` stuck state (Issue 5 — CRITICAL)
**File:** `useInitializeServices.ts:518-531`

Add a periodic health check for the server socket:
```typescript
// Inside initTransportsForUser, after opening server socket:
const serverSocketHealthCheck = setInterval(async () => {
  if (groupRole !== 'owner' || !serverSocketBound) return;
  const info = await AndroidWifiP2PTransport.getConnectionInfo();
  if (!info.groupFormed) {
    console.log('[P2P] Server socket health check: group dissolved. Resetting.');
    serverSocketBound = false;
    groupRole = 'unassigned';
  }
}, 15000);
```
Clear this interval in `shutdownTransports()`.

#### 4E: Fix `groupRole` stuck as `client` (Issue 5)
**File:** `useInitializeServices.ts`

Add a timeout: if `groupRole === 'client'` for >20s without an active connection, reset to `'unassigned'` and trigger cleanup + re-discovery.

```typescript
let groupRoleTimer: ReturnType<typeof setTimeout> | null = null;
const setGroupRole = (role: typeof groupRole) => {
  groupRole = role;
  if (groupRoleTimer) clearTimeout(groupRoleTimer);
  if (role === 'client') {
    groupRoleTimer = setTimeout(async () => {
      if (groupRole === 'client' && connectionsByKey.size === 0) {
        console.log('[P2P] groupRole stuck as client for 20s. Resetting.');
        groupRole = 'unassigned';
        await performP2PCleanup('Client Timeout');
        AndroidWifiP2PTransport.discoverPeers().catch(() => {});
      }
    }, 20000);
  }
};
```

#### 4F: Consolidate handshake retry systems (Issue 5)
**File:** `secure-transport.ts:171-196`

Remove `scheduleHandshakeRetry()` (the internal 1s retry timer). Keep:
1. `scheduleHandshakeRecovery()` in `useInitializeServices.ts:202-213` (2s interval, per-connection)
2. `ChatService.startHeartbeatTimer()` (10s interval, global safety net)

Preserve the 15-second handshake timeout — move it to `scheduleHandshakeRecovery`:
```typescript
const scheduleHandshakeRecovery = () => {
  clearHandshakeRecovery();
  let retryCount = 0;
  handshakeRecoveryTimer = setInterval(() => {
    retryCount++;
    if (retryCount > 7 || secure.isHandshakeComplete() || !raw.isConnected()) {
      clearHandshakeRecovery();
      if (retryCount > 7 && !secure.isHandshakeComplete()) {
        console.log(`[P2P][${connKey}] Handshake failed after 14s. Disconnecting.`);
        raw.disconnect().catch(() => {});
      }
      return;
    }
    secure.establishHandshake(true).catch(() => {});
  }, 2000);
};
```

#### 4G: Reduce TCP connect attempts (Issue 5)
**File:** `useInitializeServices.ts:607-634`

Reduce from 5 attempts to 3, cap max delay at 800ms:
```
Attempt 1: 200ms delay
Attempt 2: 400ms delay
Attempt 3: 800ms delay -> if all fail, cleanup + re-discover
```
Total worst-case: ~1.4s (down from ~6.2s backoff + 75s native timeouts)

#### 4H: Add re-discovery after empty owner address (Issue 5)
**File:** `useInitializeServices.ts:588-593`

After the attempts to fetch owner address all fail and `performP2PCleanup` runs, add:
```typescript
AndroidWifiP2PTransport.discoverPeers().catch(() => {});
```

#### 4I: Remove `firstPeerIpPromise` entirely
**File:** `useInitializeServices.ts:493-501, 909-922`

Delete the `firstPeerIpPromise`, `resolveFirstPeerIp`, `rejectFirstPeerIp`, `firstPeerIpResolved`, and `firstPeerIpTimeout` variables. Delete the `await firstPeerIpPromise` block and the promise resolution in `handleConnectionInfo`. The group formation is already handled by the event handler; no promise gate needed.

### Test Criteria
- **Launch:** App shows UI (ChatListScreen or LoginScreen) within 4 seconds on physical device with no peers nearby
- **Transport init:** BLE advertising and Wi-Fi Direct discovery start in background after UI is visible
- **Reconnection:** After killing Wi-Fi Direct on peer device, both devices re-establish connection within 5 seconds of peer returning
- **Stuck state:** After simulating half-open TCP (e.g., firewall drop), device recovers within 20 seconds
- **Server socket:** After owner's server socket dies, new clients can still connect (health check detects and resets)
- `pnpm --filter mobile exec tsc --noEmit` passes
- `pnpm --filter mobile exec jest` passes

### STOP CHECKPOINT
- [ ] Launch to interactive UI < 4 seconds (no peers nearby)
- [ ] Transport init visible in logs AFTER UI renders
- [ ] Reconnection < 5 seconds on physical devices
- [ ] No stuck states after simulated failures (half-open TCP, server socket death)
- [ ] performP2PCleanup completes in < 1.5 seconds
- [ ] TypeScript compiles
- [ ] All existing tests pass

---

## Multi-Hop Routing Compatibility Notes

These fixes are designed to not conflict with future multi-hop routing:

1. **Hub relay logic** (`useInitializeServices.ts:248-288`): Transport decoupling does not affect relay — it runs inside `setupPeerConnection`'s `receive` callback, which is registered when a connection establishes, independent of `setServices()`.

2. **`getOutboundTransport` fallback** (`ChatService.ts:231-241`): This routes through the single hub when no direct transport exists. No Phase 1-4 changes modify this method. Future multi-hop would extend it to route through intermediate peers.

3. **Transport registry** (`activeTransports` Map): The consolidation in Phase 4F (removing SecureTransport's internal retry) does not change how transports are registered/unregistered. The `registerActiveTransport`/`unregisterActiveTransport` API is unchanged.

4. **Mutable closure state** (`connectionsByKey`, `groupRole`, `serverSocketBound`): These remain closure-scoped in `initAsync()`. Multi-hop would need per-hop transport tracking, which could be added as a new `Map<string, Map<string, PeerConnection>>` (peer -> connections) without touching the existing structure.

---

## Summary: File Change Matrix

| File | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|------|---------|---------|---------|---------|
| `ble-advertiser.ts` | Comments | | | |
| `ble-scanner.ts` | Comments | | | |
| `__tests__/transport.test.ts` | Test fixes | | | |
| `repository.ts` | | Read-outside-write, Q.take limits, cleanup method | | |
| `ChatService.ts` | | Batch markAsRead, optimize observeConversations, debounce | distinctUntilChanged, memo cache | |
| `ChatScreen.tsx` | | | Memo toDisplayMessage, remove scrollToEnd, useRef keyboard, FlatList props, React.memo | |
| `ChatListScreen.tsx` | | | Throttle transport subscription | |
| `MapService.ts` | | Location cleanup call | | |
| `schema.ts` | | Version bump + timestamp index | | |
| `useInitializeServices.ts` | | LokiJS config | | Decouple init, remove firstPeerIpPromise, optimize cleanup, serverSocket health, groupRole timeout, handshake consolidation, TCP retries, re-discovery |
| `secure-transport.ts` | | | | Remove scheduleHandshakeRetry, move timeout to recovery |
| `SosService.ts` | | Remove dead code | | |

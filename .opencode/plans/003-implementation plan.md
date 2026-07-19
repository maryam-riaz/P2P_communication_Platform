# 003 — BLE Scan, Handshake, UI & DB Reliability Plan

**Date:** 2026-07-19
**Input:** Log analysis from `002.txt` (two physical devices, both plans 001+002 applied, peers still not discovered)
**Goal:** Fast BLE peer detection, stable handshakes, smooth UI, efficient DB

---

## Diagnosis (Why Plans 001+002 Didn't Fix BLE Discovery)

Logs from two physical devices show **100% of scanned packets are third-party devices** — zero SOSIFY peer advertisements detected. Two root causes:

1. **`manufacturerData` key format is hex (`"ffff"`) but `react-native-ble-manager` uses decimal (`"65535"`)** — Path 1 extraction always fails, forcing the `.slice(4)` fallback that only sees non-peer noise.

2. **Duty cycle too conservative (4s scan / 8s sleep = 33%)** — A rescuer passes through in 10-30 seconds. With 67% idle, detection probability is ~40%. Disaster comms need near-continuous scanning.

Handshake drops are caused by: premature `isConnectedFlag` set on client, stuck `serverSocketBound` after disconnect, and 4 overlapping retry mechanisms racing each other.

---

## Part A — BLE: Fast Peer Detection

### A1: Fix `manufacturerData` Key Format

**File:** `packages/mobile/src/comms/ble/ble-scanner.ts:135`

**Root cause:** `DISASTER_P2P_MANUFACTURER_ID.toString(16)` produces `"ffff"` (hex). `react-native-ble-manager` delivers `manufacturerData` keys as the decimal string `"65535"`. Path 1 never matches.

**Change:**

```typescript
// Line 135 — BEFORE:
const mfgIdKey = DISASTER_P2P_MANUFACTURER_ID.toString(16).toLowerCase().padStart(4, '0');

// Line 135 — AFTER:
const mfgIdKey = String(DISASTER_P2P_MANUFACTURER_ID); // "65535" — react-native-ble-manager uses decimal keys
```

Also update the comment on line 133:

```typescript
// Line 133 — BEFORE:
// react-native-ble-manager delivers manufacturerData as Record<string, CustomAdvertisingData>
// where the key is the 4-character hex string of the manufacturer ID (e.g., "ffff")

// Line 133 — AFTER:
// react-native-ble-manager delivers manufacturerData as Record<string, CustomAdvertisingData>
// where the key is the decimal string of the manufacturer ID (e.g., "65535" for 0xFFFF)
```

**Verification:** After this fix, Path 1 logs should appear: `[BLE] Extracted via manufacturerData[65535].bytes (length=23)`. The magic check at line 99 (`bytes[0] === 0xD2 && bytes[1] === 0x50`) should then pass for peer advertisements.

---

### A2: Aggressive Duty Cycle + Low-Latency Scan Mode

**File:** `packages/mobile/src/comms/ble/ble-scanner.ts:293-310`

**Change scan parameters:**

```typescript
// Lines 293-294 — BEFORE:
const SCAN_ACTIVE_MS = 4000;
const SCAN_SLEEP_MS = 8000;

// Lines 293-294 — AFTER:
const SCAN_ACTIVE_MS = 8000;  // 8s scan (up from 4s)
const SCAN_SLEEP_MS = 2000;   // 2s sleep (down from 8s) → 80% duty cycle
```

```typescript
// Lines 308-309 — BEFORE:
matchMode: 2, // MATCH_MODE_AGGRESSIVE
scanMode: 2,  // SCAN_MODE_BALANCED

// Lines 308-309 — AFTER:
matchMode: 2, // MATCH_MODE_AGGRESSIVE
scanMode: 3,  // SCAN_MODE_LOW_LATENCY — fastest discovery at expense of battery
```

**Rationale:** `SCAN_MODE_LOW_LATENCY` (value 3) scans most aggressively. The 8s/2s cycle gives 80% duty. Battery impact is acceptable for a disaster comms app where detection speed saves lives.

---

### A3: Advertiser Capability Logging + Health Check

**File:** `packages/mobile/src/hooks/useInitializeServices.ts:510-515`

**Change advertiser startup to log capability:**

```typescript
// Lines 510-515 — BEFORE:
currentAdvertiser = new BleAdvertiser(deviceId, role, pubKeyHash, displayName);
try {
  await currentAdvertiser.startAdvertising();
} catch (err) {
  console.warn('[P2P Bootstrap] Failed to start BLE advertising (check if Bluetooth is enabled):', err);
}

// Lines 510-515 — AFTER:
currentAdvertiser = new BleAdvertiser(deviceId, role, pubKeyHash, displayName);
try {
  const capability = await currentAdvertiser.startAdvertising();
  console.log(`[P2P Bootstrap] BLE advertising started. Capability: ${capability}`);
  if (capability === 'scan_only') {
    console.warn('[P2P Bootstrap] BLE advertising degraded to scan-only. Device cannot advertise — peers will not discover us.');
  }
} catch (err) {
  console.warn('[P2P Bootstrap] Failed to start BLE advertising (check if Bluetooth is enabled):', err);
}
```

**Add advertiser health check** — after the BLE scan starts (after line 916), add a 60-second interval:

```typescript
// After line 916 (await startScanning(handlePeerDiscovered)):
const advertiserHealthCheck = setInterval(async () => {
  if (currentAdvertiser && !currentAdvertiser.getIsAdvertising()) {
    console.warn('[P2P Health] BLE advertiser stopped. Restarting...');
    try {
      const capability = await currentAdvertiser.startAdvertising();
      console.log(`[P2P Health] BLE advertiser restarted. Capability: ${capability}`);
    } catch (err) {
      console.warn('[P2P Health] Failed to restart BLE advertising:', err);
    }
  }
}, 60_000);
```

This requires adding a `getIsAdvertising()` getter to `BleAdvertiser` class in `ble-advertiser.ts`:

```typescript
// Add to BleAdvertiser class (after line 127):
getIsAdvertising(): boolean {
  return this.isAdvertising;
}
```

Clear the health check interval in `shutdownTransports()` (add near existing cleanup code).

---

### A4: RSSI-Based Near-Peer Priority

**File:** `packages/mobile/src/comms/ble/ble-scanner.ts:160-175`

**Add RSSI filtering** after extraction, before calling the advertisement handler:

```typescript
// After line 160 (if (!payloadBytes) return;), add:
// Filter by RSSI — only process advertisements from nearby devices
// RSSI < -90 dBm is too weak for Wi-Fi Direct connection
const rssi = peripheral.rssi ?? 0;
if (rssi < -90) {
  return; // Too far away — skip
}
```

Also update the `BLEAdvertisementData` to include the RSSI (it's already in the interface but set to `undefined`):

```typescript
// In parseFullPayload (line 47) and parseTrimmedPayload (line 69):
// BEFORE:
rssi: undefined,

// AFTER: (remove — RSSI is set in onDiscoverPeripheral after parsing)
```

And in `onDiscoverPeripheral` (after parsing), set the RSSI:

```typescript
// After the parseAdvertisementPacket call, before calling advertisementHandler:
parsed.rssi = peripheral.rssi ?? 0;
```

---

## Part B — Handshake: Stop Drops After Connect

### B1: Fix Premature `isConnectedFlag` on Client

**File:** `packages/mobile/src/comms/wifi-direct/wifi-p2p-transport.android.ts:316-329`

**Root cause:** `isConnectedFlag` is set to `true` immediately after `connectToSocket()` resolves (line 325), but the server hasn't accepted yet. If `establishHandshake()` fires before the server's `WifiDirectTcpConnected` event, the PUBKEY_EXCHANGE message can be lost.

**Change:** Defer `isConnectedFlag` until the `WifiDirectTcpConnected` native event fires:

```typescript
// Lines 316-329 — BEFORE:
async connectToSocket(ipAddress: string, port: number = 8888): Promise<void> {
  if (!WifiDirect) {
    console.warn('[Android Wi-Fi Direct] connectToSocket: native module not available.');
    return;
  }
  this._isServer = false;
  console.log(`[Android Wi-Fi Direct] Connecting TCP socket to ${ipAddress}:${port}`);
  this.setupNativeListeners();
  await WifiDirect.connectToSocket(ipAddress, port);
  this.isConnectedFlag = true;
  // Yield one microtask so the server-side WifiDirectTcpConnected event can
  // fire and set isConnected() on the server transport before the test asserts.
  await Promise.resolve();
  console.log('[Android Wi-Fi Direct] TCP connection established to group owner.');
}

// Lines 316-329 — AFTER:
async connectToSocket(ipAddress: string, port: number = 8888): Promise<void> {
  if (!WifiDirect) {
    console.warn('[Android Wi-Fi Direct] connectToSocket: native module not available.');
    return;
  }
  this._isServer = false;
  console.log(`[Android Wi-Fi Direct] Connecting TCP socket to ${ipAddress}:${port}`);
  this.setupNativeListeners();
  // Wait for both the native promise AND the TcpConnected event
  await WifiDirect.connectToSocket(ipAddress, port);
  // Do NOT set isConnectedFlag here — wait for the WifiDirectTcpConnected event
  // to fire (handled in setupNativeListeners). This ensures the server has
  // accepted the TCP connection before we start the handshake.
  // Yield one microtask to let the TcpConnected event queue.
  await Promise.resolve();
  console.log('[Android Wi-Fi Direct] TCP connection initiated to group owner.');
}
```

Also update the `WifiDirectTcpConnected` handler (line 264) to set the flag:

```typescript
// In setupNativeListeners, the connected handler should be:
this.connectedSubscription = this.wifiDirectEmitter.addListener(
  'WifiDirectTcpConnected',
  () => {
    this.isConnectedFlag = true;
    console.log('[Android Wi-Fi Direct] TCP socket connected (TcpConnected event).');
    if (this.connectCallback) {
      this.connectCallback();
    }
  }
);
```

**Add a timeout fallback** — if `isConnectedFlag` isn't set within 5 seconds of `connectToSocket()`, set it anyway (to handle cases where the event is missed):

```typescript
// After the connectToSocket call, add:
const connectTimeout = setTimeout(() => {
  if (!this.isConnectedFlag) {
    console.warn('[Android Wi-Fi Direct] TcpConnected event not received within 5s. Setting isConnectedFlag anyway.');
    this.isConnectedFlag = true;
  }
}, 5000);
// Clear the timeout when TcpConnected fires (in the connected handler above)
```

---

### B2: Fix `serverSocketBound` Stuck State

**File:** `packages/mobile/src/hooks/useInitializeServices.ts:530-543`

**Root cause:** If the server socket drops but `serverSocketBound` stays `true`, new clients get `connection refused`. The reset only happens when ALL connections are gone, but a zombie socket prevents this.

**Change:** Add a periodic health check for the server socket. Add after the `handleConnectionInfo` definition (after line 654):

```typescript
// Server socket health check — runs every 15s
const serverSocketHealthCheck = setInterval(async () => {
  if (groupRole !== 'owner' || !serverSocketBound) return;
  try {
    const info = await AndroidWifiP2PTransport.getConnectionInfo();
    if (!info.groupFormed) {
      console.log('[P2P Health] Server socket health check: group dissolved. Resetting serverSocketBound.');
      serverSocketBound = false;
      groupRole = 'unassigned';
    }
  } catch (err) {
    console.warn('[P2P Health] Server socket health check failed:', err);
  }
}, 15_000);
```

Clear this interval in `shutdownTransports()`.

---

### B3: Consolidate Retry Mechanisms — Remove Overlap

**Files:** `packages/mobile/src/comms/secure-transport.ts:171-196`, `packages/mobile/src/hooks/useInitializeServices.ts:215-232`

**Root cause:** Four overlapping retry mechanisms fight each other:
1. `scheduleHandshakeRetry()` in `secure-transport.ts` (2s timer, 15s timeout)
2. `scheduleHandshakeRecovery()` in `useInitializeServices.ts` (5s timer)
3. `ChatService.startHeartbeatTimer()` (10s interval)
4. The `onDisconnect` cleanup handler

The race at lines 178-185 in `secure-transport.ts` is particularly dangerous: the 15s timeout calls `rawTransport.disconnect()` which fires the `onDisconnect` handler right as the handshake may be completing at line 299.

**Change:** Remove `scheduleHandshakeRetry()` from `secure-transport.ts`. Keep only `scheduleHandshakeRecovery()` from `useInitializeServices.ts`.

In `secure-transport.ts`:

1. **Delete** the `scheduleHandshakeRetry()` method (lines 171-196)
2. **Delete** the `clearHandshakeRetryTimer()` method (lines 198-203)
3. **Delete** the `handshakeRetryTimer` and `handshakeRetryStartTime` fields
4. **Remove** the call to `this.scheduleHandshakeRetry()` at line 165 (in `establishHandshake`)
5. **Remove** the call to `this.clearHandshakeRetryTimer()` at line 300 (in `processPacket`)
6. **Remove** the call to `this.clearHandshakeRetryTimer()` at line 128 (in the rawTransport `onDisconnect` callback)
7. **Remove** the call to `this.clearHandshakeRetryTimer()` at line 379 (in `disconnect`)

In `useInitializeServices.ts`, update `scheduleHandshakeRecovery` to include the 15s total timeout (currently in the deleted `scheduleHandshakeRetry`):

```typescript
// In setupPeerConnection, replace the existing scheduleHandshakeRecovery with:
const scheduleHandshakeRecovery = () => {
  clearHandshakeRecovery();
  let retryCount = 0;
  handshakeRecoveryTimer = setInterval(() => {
    retryCount++;
    const elapsed = retryCount * 5; // 5s per tick
    if (secure.isHandshakeComplete() || !raw.isConnected()) {
      clearHandshakeRecovery();
      return;
    }
    if (elapsed > 15) {
      console.log(`[P2P][${connKey}] Handshake failed after 15s. Disconnecting.`);
      clearHandshakeRecovery();
      raw.disconnect().catch(() => {});
      return;
    }
    console.log(`[P2P][${connKey}] Handshake retry (${elapsed}s elapsed)...`);
    secure.establishHandshake(true).catch(() => {});
  }, 5000);
};
```

---

### B4: Reconnect When Peer Is Still in BLE Range

**File:** `packages/mobile/src/hooks/useInitializeServices.ts:390-430`

**Root cause:** After a disconnect, the full `performP2PCleanup` → `discoverPeers` → `onPeersChanged` → `connectToPeer` cycle takes 5+ seconds. If the peer is still nearby, this delay is unnecessary.

**Change:** In the `onDisconnect` handler (line 390), check if the peer is still BLE-discovered before doing full cleanup:

```typescript
// Lines 390-430 — REPLACE the onDisconnect handler with:
raw.onDisconnect(async () => {
  clearHandshakeRecovery();
  const remoteId = entry.deviceId ?? secure.getRemoteDeviceId();
  if (remoteId) {
    console.log(`[P2P DEBUG][${connKey}] TCP socket disconnected. Unregistering transport for: ${remoteId}`);
    chatService.unregisterActiveTransport(remoteId);
  }
  chatService.unregisterSecureTransport(secure);
  connectionsByKey.delete(connKey);
  if (entry.deviceAddress) {
    connectionsByKey.delete(entry.deviceAddress);
    connectingKeys.delete(entry.deviceAddress);
  }
  connectingKeys.delete(connKey);

  // FAST PATH: If peer is still visible via BLE, attempt immediate reconnection
  // without full P2P cleanup (which takes 2-5s). Only do full cleanup if no
  // BLE peers are visible or we're the owner with no remaining connections.
  const peerStillNearby = remoteId && Array.from(bleDiscoveredIds.values()).includes(remoteId);

  if (connectionsByKey.size === 0) {
    connectingKeys.clear();
    serverSocketBound = false;
    groupRole = 'unassigned';

    if (peerStillNearby) {
      // Fast reconnect: skip full cleanup, just re-trigger discovery
      console.log(`[P2P DEBUG][${connKey}] Peer ${remoteId} still nearby. Fast reconnecting...`);
      AndroidWifiP2PTransport.discoverPeers().catch(() => {});
    } else {
      // Full cleanup when peer is gone
      console.log('[P2P DEBUG] Peer not nearby. Performing full P2P cleanup...');
      await performP2PCleanup('All Clients Disconnected').catch((err) =>
        console.warn('[P2P DEBUG] performP2PCleanup after full disconnect failed:', err)
      );
    }
  } else if (groupRole === 'client') {
    groupRole = 'unassigned';
    // Client lost connection but other connections exist — re-discover
    AndroidWifiP2PTransport.discoverPeers().catch(() => {});
  } else {
    // Owner still has other connections — just re-discover for the lost peer
    AndroidWifiP2PTransport.discoverPeers().catch(() => {});
  }
});
```

**Add `bleDiscoveredIds` access** — the `bleDiscoveredIds` Map is already defined in the closure scope (line 130-131), so this reference works.

---

## Part C — UI: Seamless and Smooth

### C1: Throttle Location Logging + Broadcasts

**File:** `packages/mobile/src/services/MapService.ts:211-240`

**Root cause:** `handleLocationUpdate` fires on every GPS update (~1s) and does both a DB write AND broadcasts to ALL peers. This floods the JS thread.

**Change:** Add a 5-second throttle:

```typescript
// Add a new field to the MapService class:
private lastLocationBroadcastTime = 0;
private static LOCATION_THROTTLE_MS = 5000;

// In handleLocationUpdate (line 211), wrap the DB write and broadcast:
private async handleLocationUpdate(coords: { latitude: number; longitude: number; accuracy: number }) {
  // Always emit to the subject for immediate UI update (no DB write needed)
  this.myLocationSubject.next({
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy,
  });

  const now = Date.now();
  if (now - this.lastLocationBroadcastTime < MapService.LOCATION_THROTTLE_MS) {
    return; // Throttled — skip DB write and peer broadcast
  }
  this.lastLocationBroadcastTime = now;

  const localUser = await this.repository.getLocalUser();
  if (localUser) {
    const myDeviceId = (localUser._raw as any).device_id as string;

    // 1. Log coordinates locally (offload to InteractionManager)
    InteractionManager.runAfterInteractions(() => {
      this.repository.logLocation({
        deviceId: myDeviceId,
        lat: coords.latitude,
        lng: coords.longitude,
        accuracy: coords.accuracy,
        source: 'gps',
      }).catch(err => console.warn('[MapService] Failed to log location:', err));
    });

    // 2. Share coordinates with all active P2P sockets
    if (this.chatService) {
      const activeTransports = this.chatService.getAllActiveTransports();
      for (const [peerId, transport] of activeTransports.entries()) {
        if (transport.isHandshakeComplete()) {
          try {
            const payload = {
              type: 'location_share',
              senderId: myDeviceId,
              lat: coords.latitude,
              lng: coords.longitude,
              timestamp: Date.now(),
            };
            await transport.send(JSON.stringify(payload));
          } catch (err) {
            // Transport might be stale — skip silently
          }
        }
      }
    }
  }
}
```

Add `import { InteractionManager } from 'react-native';` at the top of `MapService.ts`.

---

### C2: Remove `checkGps()` 3-Second Interval from MapScreen

**File:** `packages/mobile/src/screens/app/MapScreen.tsx:254-256`

**Root cause:** `checkGps()` runs every 3 seconds via `setInterval`. GPS state rarely changes and the async call (`Location.hasServicesEnabledAsync`) adds unnecessary JS thread work.

**Change:** Replace the interval with a one-time check (GPS state is event-driven on Android):

```typescript
// Lines 251-256 — BEFORE:
// Check GPS and Bluetooth immediately and periodically
checkGps();
checkBluetooth();
const interval = setInterval(() => {
  checkGps();
}, 3000);

// Lines 251-256 — AFTER:
// Check GPS and Bluetooth once at mount
checkGps();
checkBluetooth();
// No periodic interval — GPS state changes are rare and event-driven
```

Remove the `clearInterval(interval)` from the cleanup function (line 271) since there's no interval anymore. Keep the `checkBluetooth()` one-shot.

---

### C3: Wrap Non-Urgent DB Writes in InteractionManager

**File:** `packages/mobile/src/hooks/useInitializeServices.ts`

**Change:** In the `onHandshakeReady` callback (lines 341-388), wrap the peer DB write in `InteractionManager.runAfterInteractions`:

```typescript
// In the onHandshakeReady callback, wrap the addNewPeer call:
secure.onHandshakeReady(async () => {
  clearHandshakeRecovery();
  const remoteId = secure.getRemoteDeviceId();
  entry.deviceId = remoteId;
  chatService.registerActiveTransport(remoteId, secure);
  connectingKeys.delete(connKey);

  // Offload DB write to avoid blocking UI
  InteractionManager.runAfterInteractions(async () => {
    try {
      await peersRepo.addNewPeer({ deviceId: remoteId, publicKey, role, trustStatus, displayName });
    } catch (err) {
      console.warn('[P2P] Failed to persist peer after handshake:', err);
    }
  });

  // Send initial location share (non-blocking)
  try {
    await secure.send(JSON.stringify({
      type: 'location_share',
      senderId: deviceId,
      lat: 0,
      lng: 0,
      timestamp: Date.now(),
    }));
  } catch (err) {
    // Non-critical
  }
});
```

Add `import { InteractionManager } from 'react-native';` at the top of `useInitializeServices.ts`.

---

## Part D — Database: Efficient Reads and Writes

### D1: Add Missing `Q.take()` Limits

**File:** `packages/mobile/src/db/repository.ts`

**Change `getSosEvents` (lines 209-211):**

```typescript
// BEFORE:
async getSosEvents(): Promise<SosEvent[]> {
  return await this.db.get<SosEvent>('sos_events').query().fetch();
}

// AFTER:
async getSosEvents(): Promise<SosEvent[]> {
  return await this.db.get<SosEvent>('sos_events')
    .query(
      Q.sortBy('created_at', Q.desc),
      Q.take(50)
    )
    .fetch();
}
```

**Change `getPendingSyncItems` (lines 265-270):**

```typescript
// BEFORE:
async getPendingSyncItems(): Promise<SyncQueue[]> {
  return await this.db
    .get<SyncQueue>('sync_queue')
    .query(Q.sortBy('created_at', Q.asc))
    .fetch();
}

// AFTER:
async getPendingSyncItems(): Promise<SyncQueue[]> {
  return await this.db
    .get<SyncQueue>('sync_queue')
    .query(Q.sortBy('created_at', Q.asc), Q.take(100))
    .fetch();
}
```

Add `import { Q } from '@nozbe/watermelondb';` if not already imported.

---

### D2: Batch Location Cleanup

**File:** `packages/mobile/src/db/repository.ts:252-263`

**Change:** Replace per-record `destroyPermanently()` loop with batch:

```typescript
// Lines 252-263 — BEFORE:
async cleanupOldLocations(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<void> {
  const cutoff = Date.now() - olderThanMs;
  const stale = await this.db.get<LocationLog>('location_log')
    .query(Q.where('timestamp', Q.lt(cutoff)))
    .fetch();
  if (stale.length === 0) return;
  await this.db.write(async () => {
    for (const loc of stale) {
      await loc.destroyPermanently();
    }
  });
}

// AFTER:
async cleanupOldLocations(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<void> {
  const cutoff = Date.now() - olderThanMs;
  const stale = await this.db.get<LocationLog>('location_log')
    .query(Q.where('timestamp', Q.lt(cutoff)))
    .fetch();
  if (stale.length === 0) return;
  // Batch destroy in a single write transaction
  await this.db.write(async () => {
    await Promise.all(stale.map(loc => loc.destroyPermanently()));
  });
}
```

---

### D3: Add Index on `sync_queue.created_at`

**File:** `packages/mobile/src/db/schema.ts:94-103`

**Change:** Add `isIndexed: true` to `created_at` and bump schema version to 5:

```typescript
// Line 29 — BEFORE:
version: 4,

// Line 29 — AFTER:
version: 5,
```

```typescript
// Lines 94-103 — BEFORE:
tableSchema({
  name: 'sync_queue',
  columns: [
    { name: 'record_type', type: 'string' },
    { name: 'record_id', type: 'string' },
    { name: 'attempts', type: 'number' },
    { name: 'last_attempt_at', type: 'number', isOptional: true },
    { name: 'created_at', type: 'number' },
  ],
}),

// AFTER:
tableSchema({
  name: 'sync_queue',
  columns: [
    { name: 'record_type', type: 'string' },
    { name: 'record_id', type: 'string' },
    { name: 'attempts', type: 'number' },
    { name: 'last_attempt_at', type: 'number', isOptional: true },
    { name: 'created_at', type: 'number', isIndexed: true },
  ],
}),
```

Add a migration for version 4→5 in the migrations array (lines 4-26):

```typescript
{
  toVersion: 5,
  steps: [
    // Add index on sync_queue.created_at
    // WatermelonDB handles index creation via isIndexed in schema
  ],
},
```

---

## Implementation Order

### Phase 1: BLE Discovery Fix (A1 + A2) — HIGHEST PRIORITY
These are independent and the most impactful:
1. **A1**: Fix `manufacturerData` key format in `ble-scanner.ts:135`
2. **A2**: Increase duty cycle and scan mode in `ble-scanner.ts:293-310`

**STOP CHECKPOINT:** Re-capture logs with two devices. Verify `manufacturerData[65535].bytes` extraction path appears and `parseAdvertisementPacket` returns non-null for peer packets.

### Phase 2: BLE Robustness (A3 + A4)
3. **A3**: Advertiser capability logging + health check in `useInitializeServices.ts` and `ble-advertiser.ts`
4. **A4**: RSSI filtering in `ble-scanner.ts:160-175`

### Phase 3: Handshake Fixes (B1 + B3) — CRITICAL FOR STABILITY
5. **B1**: Fix premature `isConnectedFlag` in `wifi-p2p-transport.android.ts:316-329`
6. **B3**: Consolidate retry mechanisms in `secure-transport.ts:171-203` and `useInitializeServices.ts:215-232`

### Phase 4: Handshake Resilience (B2 + B4)
7. **B2**: Server socket health check in `useInitializeServices.ts:530-543`
8. **B4**: Fast reconnect when peer still nearby in `useInitializeServices.ts:390-430`

### Phase 5: UI & DB (C1-C3 + D1-D3)
9. **C1**: Throttle location logging in `MapService.ts:211-240`
10. **C2**: Remove GPS interval in `MapScreen.tsx:254-256`
11. **C3**: InteractionManager guards in `useInitializeServices.ts:341-388`
12. **D1**: Q.take limits in `repository.ts:209-211, 265-270`
13. **D2**: Batch cleanup in `repository.ts:252-263`
14. **D3**: sync_queue index in `schema.ts:29, 94-103`

**After each phase, run:**
```bash
pnpm --filter mobile exec tsc --noEmit
pnpm --filter mobile exec jest
```

---

## File Change Matrix

| File | A1 | A2 | A3 | A4 | B1 | B2 | B3 | B4 | C1 | C2 | C3 | D1 | D2 | D3 |
|------|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| `ble-scanner.ts` | ✅ | ✅ | — | ✅ | — | — | — | — | — | — | — | — | — | — |
| `ble-advertiser.ts` | — | — | ✅ | — | — | — | — | — | — | — | — | — | — | — |
| `useInitializeServices.ts` | — | — | ✅ | — | — | ✅ | ✅ | ✅ | — | — | ✅ | — | — | — |
| `wifi-p2p-transport.android.ts` | — | — | — | — | ✅ | — | — | — | — | — | — | — | — | — |
| `secure-transport.ts` | — | — | — | — | — | — | ✅ | — | — | — | — | — | — | — |
| `MapService.ts` | — | — | — | — | — | — | — | — | ✅ | — | — | — | — | — |
| `MapScreen.tsx` | — | — | — | — | — | — | — | — | — | ✅ | — | — | — | — |
| `repository.ts` | — | — | — | — | — | — | — | — | — | — | — | ✅ | ✅ | — |
| `schema.ts` | — | — | — | — | — | — | — | — | — | — | — | — | — | ✅ |

**9 files, 14 changes. No file conflicts — all phases can be implemented independently.**

---

## Sub-Agent Assignment

Use the following subagent allocation:

| Phase | Subagent Type | Task |
|-------|--------------|------|
| Phase 1 (A1+A2) | `general` | Fix ble-scanner.ts key format + duty cycle |
| Phase 2 (A3+A4) | `general` | Add advertiser health check + RSSI filter |
| Phase 3 (B1+B3) | `general` | Fix isConnectedFlag + consolidate retries |
| Phase 4 (B2+B4) | `general` | Server socket health + fast reconnect |
| Phase 5 (C1-C3) | `general` | UI performance: throttles + InteractionManager |
| Phase 5 (D1-D3) | `general` | DB efficiency: limits + batch + index |
| Verification | `general` | Run tsc + jest after each phase |

All subagents should run `pnpm --filter mobile exec tsc --noEmit` and `pnpm --filter mobile exec jest` as verification after their changes.

---

## Verification Criteria

| Metric | Before | After |
|--------|--------|-------|
| BLE peer detection time | Never (0% detection) | < 3 seconds when in range |
| BLE duty cycle | 33% (4s/8s) | 80% (8s/2s) |
| Manufacturer data extraction | Always Path 2 (wrong key) | Path 1 (correct decimal key) |
| Handshake drop rate | High (milliseconds after connect) | 0% when in range |
| Reconnection time | 5+ seconds (full cleanup cycle) | < 2 seconds (fast reconnect) |
| DB query: getSosEvents | Unbounded fetch-all | Capped at 50 |
| DB query: getPendingSyncItems | Unbounded fetch-all | Capped at 100 |
| Location broadcast frequency | ~1/s (every GPS update) | 1/5s (throttled) |
| MapScreen GPS polling | Every 3 seconds | One-time at mount |

---

## Risk Notes

- **A1 (key format):** Low risk. If the key format was already correct, the fix is harmless. If wrong, it's the root cause of zero peer detection.
- **A2 (duty cycle):** Moderate battery impact. Acceptable for disaster comms; can be tuned later.
- **B1 (isConnectedFlag):** Medium risk. The 5s timeout fallback ensures the connection isn't permanently stuck, but may cause brief handshake failures if the TcpConnected event is consistently lost.
- **B3 (retry consolidation):** High impact. Removing retry mechanisms must be done carefully — the single remaining watchdog must cover all failure modes. Test with: successful handshake, failed handshake, TCP drop mid-handshake, Wi-Fi toggle, app background/foreground.
- **C1 (location throttle):** May cause location data to be slightly stale (up to 5s). Acceptable for disaster comms where exact real-time position is less critical than peer detection.
- **D3 (schema bump):** Requires WatermelonDB migration. Test that existing databases upgrade correctly without data loss.


## ####################################################

Implementation Session Summary
Completed (all 14 changes from the plan + test fix)
Phase 1 — A1+A2 (ble-scanner.ts):
- A1: Fixed manufacturerData key from hex "ffff" to decimal "65535"
- A2: Increased duty cycle to 8s/2s (80% active), scan mode LOW_LATENCY
Phase 2 — A3+A4 (ble-advertiser.ts, ble-scanner.ts, useInitializeServices.ts):
- A3: Added getIsAdvertising() getter on BleAdvertiser
- A4: Added RSSI < -90 dBm noise filter on scan results
- Advertiser capability logging + 60s health check with cleanup
Phase 3 — B1+B3 (wifi-p2p-transport.android.ts, secure-transport.ts, useInitializeServices.ts):
- B1: Deferred isConnectedFlag — removed premature true from connectToSocket(), waits for WifiDirectTcpConnected event
- B3: Removed scheduleHandshakeRetry(), handshakeRetryTimer, handshakeAttempts, handshakeRetryStartTime; added 15s timeout + retry in scheduleHandshakeRecovery
Phase 4 — B2+B4 (useInitializeServices.ts):
- B2: 15s server socket health check
- B4: Rewrote onDisconnect with fast reconnect via bleDiscoveredIds
Phase 5 — C1+C2+C3+D1+D2+D3 (MapService.ts, MapScreen.tsx, useInitializeServices.ts, repository.ts, schema.ts):
- C1: 5s throttle on DB write/broadcast in addKnownPeer (immediate UI emit preserved)
- C2: Removed 3s GPS interval in MapScreen
- C3: InteractionManager.runAfterInteractions wrapping addNewPeer
- D1: Q.take(50) on getSosEvents, Q.take(100) on getPendingSyncItems
- D2: Batch Promise.all for cleanupOldLocations
- D3: Schema version 4→5, isIndexed: true on sync_queue.created_at
Test Fix (critical)
The B1 change broke transport.test.ts — removing isConnectedFlag = true from connectToSocket() exposed a pre-existing race condition in the Jest mock: tcpDisconnect was destroying sockets and nulling references without first stripping event listeners, causing async close events from previous tests to leak into new tests' listener arrays. Fixed in __mocks__/react-native.ts by calling removeAllListeners() on sockets before destroy().
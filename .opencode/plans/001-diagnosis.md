# Diagnostic Report — Post Phases 1–4 Performance Fix Implementation

**Date:** 2026-07-19
**Source:** `C:\AppV6\.agents\logs\001.txt` (ReactNativeJS-only logcat of a relaunch)
**Note:** This is a **diagnosis-only** report. Do not apply fixes until all findings are reviewed.

---

## Finding 1: 3-Second BLE State Logging Loop

**Status: CONFIRMED — false-positive state events, not a listener re-subscription loop**

### Root Cause
`MapScreen.tsx:254-257` runs a 3-second health-check interval:

```typescript
const interval = setInterval(() => {
  checkGps();
  checkBluetooth();
}, 3000);
```

`checkBluetooth()` calls `getBleState()` → `BleManager.checkState()`. The native Android `checkState()` at `BleManager.java:809` always calls `emitOnDidUpdateState(map)` as a side effect — the SAME event that `BleManager.onDidUpdateState` in JS subscribes to. This causes `onBleStateChange` in `ble-scanner.ts:193` to fire and log `"State changed: on"` every 3 seconds, even though the Bluetooth adapter never actually changed state.

### Key Evidence
- `BleManager.java` has exactly 2 call sites for `emitOnDidUpdateState`: the `ACTION_STATE_CHANGED` broadcast receiver (line 142, genuine state changes) and the `checkState()` ReactMethod (line 809, always fires).
- Log timestamps show exactly 3-second spacing: `16:01:47.476`, `16:01:50.487`, `16:01:53.501`, `16:01:56.509`, `16:01:59.519` — precise interval matches `setInterval(..., 3000)`.
- `HardwarePermissionModal.tsx:99-102` has the same pattern but is **dead code** (never imported).

### Impact
- **Noise**: conceals real BLE state transitions by flooding the log with duplicates.
- **No functional harm**: the `wasOff` guard (line 200) prevents spurious scan restarts.
- **Minor perf cost**: `checkState()` → `getBluetoothAdapter().getState()` JNI call every 3 seconds.

---

## Finding 2: BLE Scan — No Discovered Device Callbacks

**Status: SCAN IS RUNNING BUT ZERO `onDiscoverPeripheral` FIRINGS LOGGED**

The duty-cycle logs (`Starting BLE scan cycle`, `Sleeping BLE scan cycle`) would confirm the scan is cycling. The capture shows `[INFO] BLE: Starting continuous scan session` (line 195), but no `[DEBUG] BLE: Starting BLE scan cycle` appears in the ReactNativeJS-filtered log — this is expected since `console.debug` may be filtered by JS log level.

No `Peer: ...` discovery log appears anywhere in the 239-line capture, even though Wi-Fi Direct found a peer (`Maryam's A32`) in the same session.

### Three Candidate Causes (in priority order)

#### (A) `legacy: false` prevents discovering legacy BLE advertisements
`ble-scanner.ts:302`: `legacy: false` is passed to `BleManager.scan()`. This creates a native `ScanSettings.Builder().setLegacy(false)` on Android. If the peer's device only supports **legacy BLE advertising** (BLE 4.x — still the majority of pre-2024 Android phones), the scanner's filter silently rejects all scan results. The `onDiscoverPeripheral` callback never fires.

**Fix:** Use `legacy: true` (or omit, as the default is `true`) on Android versions that do not support BLE 5.0 extended advertising. Or attempt extended first and fall back to legacy on empty results after a timeout.

#### (B) Manufacturer data extraction silently fails
`ble-scanner.ts:134-152` extracts `payloadBytes` from `advertising.manufacturerRawData?.bytes` or `advertising.manufacturerData[mfgIdKey]?.bytes`. The structure of `ManufacturerData` in `react-native-ble-manager` varies by platform and RN version. If neither path matches the actual delivery format:

```typescript
if (!payloadBytes) {
  return; // silent exit — no logs at all for non-matched devices
}
```

Every non-app packet is silently dropped. But no logs for app packets either — or for any packet at all — meaning either condition (A) or (B) is the bottleneck.

#### (C) Scan duty-cycle gap
4s scan + 8s sleep = 33% duty cycle. If the peer's BLE advertisements fall entirely within the 8-second sleep window, the scanner never sees them. Unlikely given the peer is advertising continuously.

### Phase 1 Verification
The `AD_PAYLOAD_SIZE_FULL = 23` and `AD_PAYLOAD_SIZE_TRIMMED = 21` constants in `ble-types.ts` match both the JS advertiser (`ble-advertiser.ts`) and the native Kotlin advertiser (`BleAdvertiserModule.kt`). The parse functions `parseFullPayload` and `parseTrimmedPayload` use these constants correctly. **No comment-only regression:** Phase 1 changes are cosmetic only and do not affect runtime behavior.

---

## Finding 3: Wi-Fi Direct `groupFormed: true` Never Arrives

**Status: BROADCAST RECEIVER IS ALIVE. EVENT EITHER NEVER FIRED OR CAPTURE WINDOW TOO SHORT.**

### Receiver Lifecycle Audit
| Lifecycle event | Receiver affected? |
|---|---|
| `AndroidWifiP2PTransport.initialize()` (startup) | Registers receiver once with `reactContext` (application Context) |
| `performP2PCleanup()` (6 call sites) | **No** — only calls `cancelConnect`, `clearPersistentGroups`, `getConnectionInfo`, `removeGroup` |
| `shutdownTransports()` (on unmount) | **No** — only removes JS-level `NativeEventEmitter` subscriptions |
| AppState handler (`useInitializeServices.ts:987-989`) | Passive no-op — logs only, no transport lifecycle changes |

The broadcast receiver persists for the entire app lifetime. It is **not torn down** during the critical window when the peer transitions `AVAILABLE(3)` (16:03:27.832) → `INVITED(1)` (16:03:34.277).

### Why `groupFormed: true` is absent from the log

Timeline after INVITED status (16:03:34.277):

1. **Browser prompt shown on remote device** — Android shows a system dialog asking the user to accept the Wi-Fi Direct invitation. Until the user taps "Accept", `groupFormed` remains `false`.
2. **If the remote user accepts**, Android fires `WIFI_P2P_CONNECTION_CHANGED_ACTION`. The Kotlin broadcast receiver calls `manager.requestConnectionInfo(channel) { info -> ... }`. If the callback fires with `groupFormed=true`, the `WifiDirectConnectionInfo` JS event fires.
3. **JS `handleConnectionInfo` logs it** — `console.log('[P2P DEBUG] Connection Info Event received:', info)` at line 501. **This log would appear in the ReactNativeJS-filtered capture. It does not.**

**Conclusion:** Either the remote user never accepted the prompt within the ~24-second capture window (16:03:34 to 16:03:58), or Android never delivered the broadcast. Given the rapid `background→active→background→active` AppState cycle at 16:03:31–34 (just before the INVITED status), a race condition exists: if the Activity was recreated during these transitions, the `Channel` object in `WifiDirectModule.kt` could be stale, causing `requestConnectionInfo()` to silently fail. The `requestConnectionInfo` callback would simply never fire — the log would appear empty.

**The 15-second polling fallback** at `useInitializeServices.ts:753-777` runs `getConnectionInfo()` every second for 15 seconds after `connectToPeer()`. But the connection was initiated by the **remote** device (we are `isInitiator=false`), so this polling loop was never started for this session.

---

## Finding 4: Relaunch Loading Screen — 1.3s JS Blocking Time

### Timestamp Breakdown (from PID 4392, relaunch)

```
Event                              Timestamp          Δ from "Running main"
─────────────────────────────────────────────────────────────────────────────
Running "main" (JS engine start)   16:03:19.783        0ms
Native WifiP2pManager init         16:03:19.881        +98ms
AppState → active                  16:03:19.882        +99ms
initTransportsForUser(existing)    16:03:20.017       +234ms
  performP2PCleanup('Bootstrap')   16:03:20.017       +234ms
    cancelConnect + wait 500ms     (approx +500ms)
    clearPersistentGroups + 500ms  (approx +500ms)
    getConnectionInfo (no group)   (approx +100ms)
  P2P cleanup done (early exit)    16:03:21.045     +1,262ms
  Permission gate (already granted)16:03:21.048     +1,265ms
  BLE manager init                 16:03:21.059     +1,276ms
  BLE advertiser start             16:03:21.075     +1,292ms
  BLE scan start                   16:03:21.076     +1,293ms
  Wi-Fi Direct discovery start     16:03:21.082     +1,299ms
→ setServices() (loading dismissed) ~16:03:21.083   ~1,300ms
```

### Breakdown by Phase

| Phase | Duration | % of blocking time |
|-------|----------|-------------------|
| `performP2PCleanup('Bootstrap')` | ~1,028ms | 79% |
| BLE init + advertiser + scan | ~51ms | 4% |
| Permission gate + location check | ~21ms | 2% |
| Wi-Fi Direct listener reg + discovery | ~8ms | 1% |
| Bundle load + native init (pre-"Running main") | **Not visible in this log** | ? |

The **dominant blocker** is `performP2PCleanup`, specifically the two hardcoded 500ms `setTimeout` waits (lines 156, 163 of `useInitializeServices.ts`).

The **pre-"Running main" time** is not captured because the log is filtered to `ReactNativeJS`. On a mid-range device, native cold start + JS bundle load from APK typically adds 2–4 seconds, which accounts for the user-reported "long loading screen."

Phase 4A (decoupling `initTransportsForUser` from `setServices`) and Phase 4C (optimizing `performP2PCleanup` timeouts) in the performance fix plan directly address this.

---

## Summary Table

| Finding | Status | Severity | Fix target |
|---------|--------|----------|------------|
| 1. 3-second BLE state loop from MapScreen interval | Confirmed | Low (noise) | Remove/refactor `MapScreen.tsx:254-257` — stop calling `checkBluetooth()` via interval |
| 2. BLE scan discovers zero devices | Unknown cause — needs unfiltered log | High | Re-capture with unfiltered logcat; add per-packet logging at extraction + magic check |
| 3. WFD `groupFormed:true` never delivered | Receiver alive; likely remote user timeout or Channel race | Medium | Add `requestConnectionInfo` error callback logging; extend capture window |
| 4. Relaunch blocks 1.3s in JS | Confirmed primary blocker: `performP2PCleanup`'s 500ms waits | High | Phase 4C: replace hardcoded timeouts with state-verification polls |

## Required Next Steps (Before Any Fixes Are Applied)

1. **Re-capture unfiltered logcat** — `adb logcat -c && adb logcat` (no `-s` filter) for both first-time launch and relaunch. Need to see:
   - `RNBleManager` tag (native BLE manager logs)
   - `WifiDirectModule` tag (native P2P logs)
   - `BleAdvertiserModule` tag (advertising logs)
   - Splash screen lifecycle logs
   - Full stack traces on any errors

2. **Add instrumentation before re-capture:**
   - `ble-scanner.ts:137`: log `manufacturerRawData` structure when it exists but `payloadBytes` is undefined
   - `ble-scanner.ts:161`: log when `parseAdvertisementPacket` returns null (distinguish magic-prefix mismatch from size mismatch)
   - `MapScreen.tsx:242-249`: add a guard to log only on actual state changes, not every `checkState()` call
   - `useInitializeServices.ts:501`: log `requestConnectionInfo` error callback alongside success

3. **Extend capture window** to at least 90 seconds after the INVITED status to cover the full 60-second group formation timeout.

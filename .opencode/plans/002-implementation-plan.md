# Implementation Plan: Diagnostic Findings (2026-07-19) — FINAL

**Date:** 2026-07-19
**Input:** `001-diagnosis.md` (diagnostic report) + `performance-fix-plan.md` (previous plan)
**Sub-agents:** 4 deep-dive code audits conducted before plan finalization

---

## Status Update from Code Audit

Deep-dive sub-agents advanced two findings beyond the diagnostic report:

- **Finding 2, Candidate B (extraction path)**: Now **CONFIRMED** from code analysis alone. The `manufacturerRawData.bytes` precedence always includes a 4-byte manufacturer ID prefix, causing the magic-number check to fail 100% of the time. Moved to Track A.
- **Finding 4 cross-check discovered**: Phase 4C's `getConnectionInfo()` poll fires the same JS event as the broadcast receiver, creating a re-entrancy race. An `isCleaningUp` guard is needed.
- **Finding 1 audit**: Found a second anti-pattern 
instance (`getConnectionInfo()` 1s×15 poll) — flagged as follow-up ticket, out of scope.

---

## Track A: Confirmed Fixes

*All phases have build+test STOP checkpoints. Not gated on re-capture.*

### Phase A1: Stop BLE State False Positives (Finding 1)

| | |
|---|---|
| **Root cause** | 3s interval calls `checkBluetooth()` -> `BleManager.checkState()`. Native `checkState()` always emits `onDidUpdateState` as a side effect, flooding logs with false-positive "State changed: on" events every 3s. |
| **Fix approach** | Remove `checkBluetooth()` from the MapScreen health-check interval. Keep `checkGps()` — it is safe (`Location.hasServicesEnabledAsync()` is a pure query with no event emission). BLE state is already tracked by the `onDidUpdateState` listener in `ble-scanner.ts`. |
| **Risk** | None — the `wasOff` guard already prevents spurious scan restarts. The interval has no functional benefit for BLE. |
| **Test criteria** | Map screen loads; GPS check still runs every 3s; no periodic "State changed: on" in logs without real BLE toggles. `pnpm --filter mobile exec jest` passes. |
| **STOP checkpoint** | [ ] Build succeeds  [ ] Tests pass  [ ] No "State changed: on" spam in 30s log capture |

### Phase A2: Fix BLE Manufacturer Data Extraction (Finding 2, Candidate B — now confirmed)

| | |
|---|---|
| **Root cause** | `manufacturerRawData.bytes` is checked first and is always populated by the native Android layer, but includes a **4-byte manufacturer ID prefix** (e.g., `[0x00, 0x00, 0xFF, 0xFF]` for ID `0xFFFF`). The magic-number check at `parseAdvertisementPacket` looks at `bytes[0]` and `bytes[1]`, which are `0x00, 0x00` instead of `0xD2, 0x50`. The correct `manufacturerData[mfgIdKey]?.bytes` path (which contains only the payload without the prefix) is shadowed and never reached. |
| **Fix approach** | Reverse extraction priority: try `manufacturerData[mfgIdKey]?.bytes` first (correct path). Fall back to `manufacturerRawData.bytes` with `.slice(4)` to strip the manufacturer ID prefix. Add `logger.debug` at extraction decision points. |
| **Risk** | Low — changes only affect the extraction path; the advertiser and parser are unchanged. Existing round-trip test validates the advertise-to-parse pipeline but bypasses extraction, so it still passes. |
| **Test criteria** | `pnpm --filter mobile exec jest` passes; extraction path logs show correct payload bytes on discovery; physical device verification: BLE scan discovers peer within 15s. |
| **STOP checkpoint** | [ ] Build succeeds  [ ] Tests pass  [ ] Extraction path fix verified on device (peer discovered within 15s of scan start) |

### Phase A3: Optimize `performP2PCleanup` with State-Verification Polls (Finding 4)

| | |
|---|---|
| **Root cause** | Two hardcoded 500ms `setTimeout` waits after `cancelConnect` and `clearPersistentGroups` block JS for ~1,028ms during relaunch. |
| **Fix approach** | (a) Replace `await setTimeout(500)` after `cancelConnect` with a `getConnectionInfo()` poll loop (up to 3 iterations, 100ms apart) that waits for `groupFormed === false`. (b) Remove the entire `await setTimeout(500)` after `clearPersistentGroups` — fire-and-forget, no feedback needed. (c) Simplify `removeGroup()` retry: 2 attempts, 300ms apart (was 3x600ms). (d) **Add `isCleaningUp` guard**: flag set during `performP2PCleanup` scope; `handleConnectionInfo` returns early if set. Prevents cleanup poll's `getConnectionInfo()` calls from re-triggering connection setup during cleanup. |
| **Risk** | Medium — the `isCleaningUp` guard prevents the identified race. Verify that genuine broadcast receiver events still fire `handleConnectionInfo` normally outside of cleanup. |
| **Test criteria** | `performP2PCleanup` completes in <500ms; no concurrent cleanup-vs-connection-setup race in logs; `pnpm --filter mobile exec tsc --noEmit` passes; `pnpm --filter mobile exec jest` passes; relaunch loading screen dismisses without visible delay. |
| **STOP checkpoint** | [ ] Build succeeds  [ ] TypeScript compiles  [ ] Tests pass  [ ] `performP2PCleanup` completes in <500ms per log timestamps  [ ] No re-entrant `handleConnectionInfo` during cleanup logged |

---

## Track B: Instrumentation + Experiments

*STOP checkpoint: "new logs captured and reviewed" — gates any follow-up fix plan for Finding 3.*

### Phase B1: BLE Scan Instrumentation + `legacy: true` Experiment (Finding 2)

| | |
|---|---|
| **Instrumentation** | (a) Log `manufacturerRawData` structure when `payloadBytes` is undefined. (b) Log when `parseAdvertisementPacket` returns null, distinguishing magic-prefix mismatch from size mismatch. These logs remain after the fix for ongoing diagnostics. |
| **Experiment** | Change `legacy: false` to `legacy: true` in the `BleManager.scan()` call. This accepts both legacy (BLE 4.x) and extended (BLE 5.0) advertising, matching the advertiser's fallback behavior. One-liner, reversible, no architectural impact. If extended-only peers are later discovered to be missed, a dynamic switch can be added. |
| **Risk** | Very low — `legacy: true` is the Android default. On devices that support extended advertising, it still receives extended packets (the scanner just doesn't filter out legacy ones). |
| **STOP checkpoint** | [ ] Instrumentation logs verified in re-capture  [ ] Re-capture shows extraction path working correctly (payload bytes extracted, magic check passes, `Peer: ...` log appears) |

### Phase B2: WFD Channel Instrumentation + Re-capture (Finding 3)

| | |
|---|---|
| **Instrumentation** | (a) Replace `null` third arg to `wifiP2pManager.initialize()` with a non-null `ChannelListener` that logs `onChannelDisconnected` with thread info. (b) Add a 5-second timeout wrapper around the native `getConnectionInfo()` promise — if it hangs, log `[P2P WARN] getConnectionInfo promise timed out — possible stale channel` and reject. (c) Add a guard on the MapScreen BLE state-change handler to log only on actual state transitions, not every `checkState()` call. |
| **Re-capture** | `adb logcat -c && adb logcat` (unfiltered) for first-time launch + relaunch. **90-second window post-INVITED status** to cover Android's full group formation timeout. |
| **What to look for** | (1) `ChannelListener` disconnect events near the INVITED timestamp. (2) `getConnectionInfo` timeout warnings. (3) Any `WifiDirectModule` error logs. (4) Confirmation that broadcast receiver fires `WIFI_P2P_CONNECTION_CHANGED_ACTION`. (5) Remote device system dialog logs. If still no `groupFormed: true`, narrow to remote user timeout vs. Channel race. |
| **STOP checkpoint** | [ ] New logs captured and reviewed  [ ] Finding 3 root cause identified (or remaining candidates narrowed to one)  [ ] Follow-up fix plan drafted for Finding 3  [ ] `legacy: true` experiment validated (or reverted if it caused regressions) |

---

## Dependencies Between Tracks

```
Track A (any order):
  Phase A1 ──── independent ────┐
  Phase A2 ──── independent ────┤
  Phase A3 ──── independent ────┼── All can merge independently
                                  │   No shared files between phases
                                  │
Track B:
  Phase B1 ──── independent ────┤
  Phase B2 ──── independent ────┤
```

No phase depends on any other phase across either track. All 6 phases touch independent files and can be implemented and merged in any order. The only logical dependency is that B2's re-capture and review must complete before drafting a Finding-3 fix plan.

---

## Files Changed — Full Matrix

| File | Phase A1 | Phase A2 | Phase A3 | Phase B1 | Phase B2 |
|---|---|---|---|---|---|
| `packages/mobile/src/screens/app/MapScreen.tsx` | Yes | — | — | — | Yes |
| `packages/mobile/src/comms/ble-scanner.ts` | — | Yes | — | Yes | — |
| `packages/mobile/src/hooks/useInitializeServices.ts` | — | — | Yes | — | Yes |
| `packages/mobile/android/.../WifiDirectModule.kt` | — | — | — | — | Yes |
| `packages/mobile/src/comms/wifi-direct/wifi-p2p-transport.android.ts` | — | — | — | — | Yes |

5 files, 6 phases. No file is shared between any two phases — zero merge conflicts possible.

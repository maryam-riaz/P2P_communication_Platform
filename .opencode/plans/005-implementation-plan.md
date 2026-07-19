# 005 — Fix BLE Advertisement Parsing: Buffer → Hermes-compatible hex

**Date:** 2026-07-19
**Bug:** `ReferenceError: Property 'Buffer' doesn't exist` crashes `parseAdvertisementPacket`, causing valid SOSIFY peer advertisements to be silently dropped.

---

## Diagnosis

### Evidence from logs

```
07-19 23:36:31.316 [BLE] Extracted via manufacturerData[ffff].bytes (length=23)
07-19 23:36:31.316 ❌ BLE: Error parsing advertisement packet
07-19 23:36:31.321 [ReferenceError: Property 'Buffer' doesn't exist]
07-19 23:36:31.323 [BLE] parseAdvertisementPacket returned null — not our app (magic prefix mismatch or no data). First bytes: [210,80,46,86], length=23
```

### Chain of failure

1. **B.0xFFFF extraction works** — `manufacturerData["ffff"].bytes` returns the correct 23-byte payload. (The previous A1 fix changing the key to `"ffff"` hex is correct.)

2. **Magic prefix is present** — `First bytes: [210,80,46,86]` = `[0xD2, 0x50, 0x2E, 0x56]`. Bytes 0-1 `0xD2 0x50` are the `DISASTER_P2P_MAGIC`. The advertisement IS ours.

3. **Buffer is unavailable** — `Buffer.from(bytes.slice(2, 18)).toString('hex')` at line 39 throws `ReferenceError` because `Buffer` is a Node.js API that does not exist in the Hermes JavaScript engine used by React Native on Android.

4. **Error swallowed** — The `catch` at line 112 catches the error, logs it, and returns `null`. The valid peer advertisement is silently dropped.

### Root cause

`Buffer.from(...)` is used in 5 locations:

| Line | Code | Purpose |
|------|------|---------|
| 39 | `Buffer.from(bytes.slice(2, 18)).toString('hex')` | Convert 16-byte device UUID to hex string (full payload) |
| 41 | `Buffer.from(bytes.slice(19, 23)).toString('hex')` | Convert 4-byte pk_hash to hex string (full payload) |
| 61 | `Buffer.from(bytes.slice(2, 18)).toString('hex')` | Convert 16-byte device UUID to hex string (trimmed payload) |
| 63 | `Buffer.from(bytes.slice(19, 21)).toString('hex')` | Convert 2-byte pk_hash to hex string (trimmed payload) |
| 90 | `Buffer.from(data, 'base64')` | Decode base64 string to binary (string input path) |

All 5 crash on Hermes.

### Existing workaround in the codebase

`packages/shared/src/crypto/ecdh.native.ts:21` already has a Hermes-safe `bytesToHex`:

```typescript
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

This is the correct pattern to use.

---

## Plan

### File to modify

`packages/mobile/src/comms/ble/ble-scanner.ts`

### Change 1 — Add Hermes-safe `bytesToHex` helper

**Insert after** the import block (line 23) and **before** `parseFullPayload` (line 36):

```typescript
/** Convert Uint8Array segment to hex string. Hermes-safe (no Buffer). */
function bytesToHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

A local copy is preferred over importing from `shared` to avoid adding a cross-package dependency for a 1-line utility.

### Change 2 — `parseFullPayload` (lines 39, 41)

```typescript
// BEFORE (line 39):
const device_id = Buffer.from(bytes.slice(2, 18)).toString('hex');
// AFTER:
const device_id = bytesToHex(bytes.slice(2, 18));

// BEFORE (line 41):
const public_key_hash = Buffer.from(bytes.slice(19, 23)).toString('hex');
// AFTER:
const public_key_hash = bytesToHex(bytes.slice(19, 23));
```

### Change 3 — `parseTrimmedPayload` (lines 61, 63)

```typescript
// BEFORE (line 61):
const device_id = Buffer.from(bytes.slice(2, 18)).toString('hex');
// AFTER:
const device_id = bytesToHex(bytes.slice(2, 18));

// BEFORE (line 63):
const public_key_hash = Buffer.from(bytes.slice(19, 21)).toString('hex');
// AFTER:
const public_key_hash = bytesToHex(bytes.slice(19, 21));
```

### Change 4 — Base64 string decode (line 90)

The base64 path is used when `parseAdvertisementPacket` receives a string argument rather than a byte array. Hermes provides `atob()` which decodes base64 to a binary string.

```typescript
// BEFORE (line 90):
bytes = new Uint8Array(Buffer.from(data, 'base64'));

// AFTER:
const binaryStr = atob(data);
bytes = new Uint8Array(binaryStr.length);
for (let i = 0; i < binaryStr.length; i++) {
  bytes[i] = binaryStr.charCodeAt(i);
}
```

### Change 5 — Remove unused `Buffer` import (no-op, Buffer is global)

No import to remove — `Buffer` is a Node.js global that Hermes doesn't provide. No change needed.

---

## What NOT to change

| Code | Lines | Reason |
|------|-------|--------|
| `manufacturerData` key format `"ffff"` | 135 | Logs confirm extraction works — hex key matches `DefaultPeripheral.java` format |
| `legacy: false` | 317 | Logs confirm extended ads are received (23-byte payload = BLE 5.0) |
| Extraction priority | 137-155 | Path 1 (`manufacturerData[ffff].bytes`) is primary and works |
| RSSI filter | 162-167 | Already working |
| `useInitializeServices.ts` | all | No changes needed — `bleDiscoveredIds` population depends on `parseAdvertisementPacket` returning non-null, which is fixed by Changes 1-4 |
| `ble-advertiser.ts`, transport files | all | No changes needed |

---

## Verification

### Build
```bash
pnpm --filter mobile exec tsc --noEmit
```

### Tests
```bash
pnpm --filter mobile exec jest
```
Note: The existing test file (`transport.test.ts`) also uses `Buffer.from(payload.slice(...)).toString('hex')` at lines 120, 127, 146, 153. These run in Jest's Node.js environment where `Buffer` exists, so they will still pass. They are test-only code and do not affect the device runtime.

### Physical device test
1. Two devices with the app running
2. Check logcat for:
   - `[BLE] Extracted via manufacturerData[ffff].bytes (length=23)` — extraction succeeds
   - `[P2P DEBUG] BLE map updated: '...' => ...` — `parseAdvertisementPacket` returns non-null, `handlePeerDiscovered` populates `bleDiscoveredIds`
3. `[ReferenceError: Property 'Buffer' doesn't exist]` should no longer appear

# Mobile Transport Layer

> Source: `packages/mobile/src/comms/`
> Platforms: Android (full), iOS (stub only)

---

## 1. Architecture Overview

```mermaid
graph TB
    subgraph "Application Layer"
        CS[ChatService]
        SOS[SosService]
        MS[MapService]
    end
    
    subgraph "Security Layer"
        ST[SecureTransport<br/>ECDH + AES-256-GCM + ECDSA]
    end
    
    subgraph "Transport Layer"
        WD[AndroidWifiP2PTransport<br/>Wi-Fi Direct TCP]
        MP[MultipeerTransport<br/>iOS stub]
    end
    
    subgraph "Discovery Layer"
        BLE_S[BleScanner]
        BLE_A[BleAdvertiser]
    end
    
    CS --> ST
    SOS --> ST
    MS --> ST
    ST --> WD
    ST --> MP
    WD --> BLE_S
    WD --> BLE_A
```

---

## 2. BLE Discovery System

### 2.1 Advertisement Packet Format (25 bytes)

> Source: `ble-advertiser.ts:29-58`, `ble-scanner.ts:29-60`

| Offset | Size | Field | Encoding |
|--------|------|-------|----------|
| 0-15 | 16 bytes | `device_id` | UUID (16 bytes, no dashes) |
| 16 | 1 byte | `role` | `0` = user, `1` = responder, `2` = admin |
| 17-20 | 4 bytes | `public_key_hash` | First 4 bytes of SHA-256(public_key), hex |
| 21-24 | 4 bytes | `timestamp` | Unix epoch seconds, **big-endian** |

**On-wire format**: 2 bytes company ID (`0xFFFF`) + 25 bytes payload = **27 bytes total**

### 2.2 BLE Local Name Format

> Source: `ble-advertiser.ts:92-93`

```
DP2P:{displayName}:{deviceIdPrefix}
```

- `displayName`: Sanitized to alphanumeric, max 10 chars
- `deviceIdPrefix`: First 8 chars of device UUID
- Example: `DP2P:Alice:abcd1234`

### 2.3 Scanning Workflow

> Source: `ble-scanner.ts:72-109`

```mermaid
sequenceDiagram
    participant App
    participant Scanner
    participant BLE as BLE Manager
    
    App->>Scanner: startScanning()
    Scanner->>Scanner: isScanning = true
    
    loop Every 35 seconds
        Scanner->>BLE: startDeviceScan(null, {allowDuplicates: false})
        Note over BLE: Scan for 35 seconds
        BLE-->>Scanner: onDeviceFound(device)
        Scanner->>Scanner: handleDiscoveredDevice(device)
        Scanner->>Scanner: Extract manufacturerData (base64)
        Scanner->>Scanner: Check: length=27, companyID=0xFFFF
        Scanner->>Scanner: unpackAdvertisementPayload(payload)
        Scanner->>App: onPeerDiscovered(BleDevice)
        
        Note over Scanner: After 35s, stop and restart
        Scanner->>BLE: stopDeviceScan()
    end
```

**Duty cycle**: 35s scan, immediate restart (no sleep between cycles)

### 2.4 Advertisement Parsing

> Source: `ble-scanner.ts:29-60`

```typescript
export function unpackAdvertisementPayload(payload: Uint8Array): {
  deviceId: string;
  role: UserRole;
  publicKeyHash: string;
  timestamp: number;
} {
  // 1. Device ID (16 bytes → UUID with dashes)
  const deviceId = bytesToUuid(payload.subarray(0, 16));

  // 2. Role (1 byte)
  const roleVal = payload[16];
  let role: UserRole = 'user';
  if (roleVal === 1) role = 'responder';
  if (roleVal === 2) role = 'admin';

  // 3. Public key hash (4 bytes → hex string)
  const hashParts: string[] = [];
  for (let i = 17; i < 21; i++) {
    hashParts.push(payload[i].toString(16).padStart(2, '0'));
  }
  const publicKeyHash = hashParts.join('');

  // 4. Timestamp (4 bytes, big-endian)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const timestamp = view.getUint32(21, false); // Big endian

  return { deviceId, role, publicKeyHash, timestamp };
}
```

### 2.5 Company ID Filtering

> Source: `ble-scanner.ts:145-149`

```typescript
if (rawBytes.length === 27 && rawBytes[0] === 0xFF && rawBytes[1] === 0xFF) {
  // Match found
  const payload = rawBytes.subarray(2); // Skip company ID
  this.onAdvertisementReceived(payload, device.rssi ?? -100, device.name ?? null);
}
```

> **Flag:** Company ID `0xFFFF` is a test/development value. Production should use a registered BLE company ID from the Bluetooth SIG.

### 2.6 Legacy Device Handling

**No legacy device support found.** The scanner expects exactly 27 bytes with company ID `0xFFFF`. Devices with different advertisement formats are silently ignored.

---

## 3. BLE Advertising System

### 3.1 Payload Packing

> Source: `ble-advertiser.ts:29-58`

```typescript
export function packAdvertisementPayload(
  deviceId: string,
  role: UserRole,
  publicKeyHashHex: string,
  timestampSeconds: number
): Uint8Array {
  const payload = new Uint8Array(25);

  // 1. Device ID (16 bytes)
  const uuidBytes = uuidToBytes(deviceId);
  payload.set(uuidBytes, 0);

  // 2. Role (1 byte)
  const roleVal = role === 'user' ? 0 : role === 'responder' ? 1 : 2;
  payload[16] = roleVal;

  // 3. Public key hash (4 bytes)
  const pkHex = publicKeyHashHex.padStart(8, '0');
  const pkHashBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    pkHashBytes[i] = parseInt(pkHex.substring(i * 2, i * 2 + 2), 16);
  }
  payload.set(pkHashBytes, 17);

  // 4. Timestamp (4 bytes, big-endian)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint32(21, timestampSeconds, false);

  return payload;
}
```

### 3.2 Advertising Workflow

> Source: `ble-advertiser.ts:81-115`

```mermaid
sequenceDiagram
    participant App
    participant Advertiser
    participant Native as NativeBleAdvertiser (Kotlin)
    
    App->>Advertiser: startAdvertising()
    Advertiser->>Advertiser: getSerializedPayload()
    Advertiser->>Advertiser: Pack 25-byte payload
    Advertiser->>Advertiser: Convert to base64
    Advertiser->>Advertiser: Sanitize displayName (alphanumeric, max 10)
    Advertiser->>Advertiser: localName = "DP2P:{name}:{idPrefix}"
    
    alt Native module available
        Advertiser->>Native: startAdvertising(payloadBase64, localName)
        Native-->>Advertiser: success
        Advertiser->>Advertiser: isAdvertising = true
    else Non-native (Jest/Node)
        Advertiser->>Advertiser: isAdvertising = true (simulated)
    end
```

---

## 4. Wi-Fi Direct Transport (Android)

### 4.1 Connection Lifecycle

> Source: `wifi-p2p-transport.android.ts`

```mermaid
sequenceDiagram
    participant App
    participant WD as WifiDirectTransport
    participant Native as WifiDirectModule (Kotlin)
    participant OS as Android WifiP2pManager
    
    App->>WD: initialize() [static, once]
    WD->>Native: initialize()
    Native->>OS: Register broadcast receivers
    OS-->>Native: WifiDirectThisDeviceChanged
    Native-->>WD: localMacAddress captured
    
    Note over App,OS: Discovery phase
    App->>WD: discoverPeers()
    WD->>Native: discoverPeers()
    Native->>OS: discoverPeers()
    OS-->>Native: WifiDirectPeersChanged
    Native-->>App: peers[] event
    
    Note over App,OS: Connection phase
    App->>WD: connectToPeer(macAddress)
    WD->>Native: connectToPeer(mac)
    Native->>OS: connect()
    OS-->>Native: WifiDirectConnectionInfo
    Native-->>App: {groupOwnerAddress, isGroupOwner}
    
    Note over App,OS: TCP socket phase
    alt I am Group Owner
        App->>WD: openServerSocket(8888)
        WD->>Native: openServerSocket(8888)
        Native->>Native: ServerSocket.bind()
    else I am client
        App->>WD: connectToSocket(groupOwnerIP, 8888)
        WD->>Native: connectToSocket(ip, 8888)
        Native->>Native: Socket.connect()
    end
    
    Note over App,OS: Data transfer
    App->>WD: send(data)
    WD->>WD: Uint8Array → base64
    WD->>Native: tcpSend(base64)
    Native->>Native: Socket.write()
    
    Native->>Native: Socket.read()
    Native-->>WD: WifiDirectTcpData(base64)
    WD->>WD: base64 → Uint8Array
    WD-->>App: messageCallback(data)
```

### 4.2 TCP Data Transfer

**Send** (Uint8Array → base64):
> Source: `wifi-p2p-transport.android.ts:325-363`

```typescript
async send(data: Uint8Array): Promise<void> {
  // Direct high-performance Uint8Array → base64 conversion
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const len = data.length;
  const parts = new Array(Math.ceil(len / 3));
  let partIdx = 0;
  
  for (let i = 0; i < len; i += 3) {
    const w1 = data[i];
    const w2 = i + 1 < len ? data[i + 1] : 0;
    const w3 = i + 2 < len ? data[i + 2] : 0;

    const byte1 = w1 >> 2;
    const byte2 = ((w1 & 3) << 4) | (w2 >> 4);
    const byte3 = ((w2 & 15) << 2) | (w3 >> 6);
    const byte4 = w3 & 63;

    let chunkStr = chars.charAt(byte1) + chars.charAt(byte2);
    chunkStr += i + 1 < len ? chars.charAt(byte3) : '=';
    chunkStr += i + 2 < len ? chars.charAt(byte4) : '=';
    
    parts[partIdx++] = chunkStr;
  }
  const base64 = parts.join('');

  await WifiDirect.tcpSend(base64);
}
```

**Receive** (base64 → Uint8Array):
> Source: `wifi-p2p-transport.android.ts:221-248`

```typescript
this.dataSubscription = this.wifiDirectEmitter.addListener(
  'WifiDirectTcpData',
  (base64: string) => {
    if (this.messageCallback) {
      const str = base64.replace(/=+$/, '');
      const len = str.length;
      const byteLen = Math.floor((len * 3) / 4);
      const bytes = new Uint8Array(byteLen);
      
      // Fast base64 decode with lookup table
      // ... (see wifi-p2p-transport.android.ts:230-244)
      
      this.messageCallback(bytes);
    }
  },
);
```

### 4.3 Deterministic Initiator Selection

> Source: `wifi-p2p-transport.android.ts:56`

```typescript
static localMacAddress: string | null = null;
```

When two devices discover each other, both may try to connect simultaneously. To avoid race conditions, the device with the **lower MAC address** initiates the connection.

---

## 5. Secure Transport

### 5.1 Handshake Protocol

> Source: `secure-transport.ts:66-76`

```typescript
async establishHandshake(): Promise<void> {
  const now = Date.now();
  if (now - this.lastHandshakeSentTime < 3000) {
    console.log('[Secure Transport] Handshake request rate-limited (cooldown active).');
    return;
  }
  this.lastHandshakeSentTime = now;
  
  const keyMsg = `PUBKEY_EXCHANGE:${this.localPublicKeyHex}:${this.localDeviceId}:${this.localDisplayName}\n`;
  await this.rawTransport.send(strToBytes(keyMsg));
}
```

**Message format**: `PUBKEY_EXCHANGE:<publicKeyHex>:<deviceId>:<displayName>\n`

**Rate limiting**: 3-second cooldown between handshake attempts

### 5.2 Handshake Workflow

```mermaid
sequenceDiagram
    participant A as Device A
    participant B as Device B
    
    Note over A,B: TCP connection established
    
    A->>A: establishHandshake()
    A->>B: PUBKEY_EXCHANGE:<pubKeyA>:<idA>:<nameA>\n
    
    B->>B: handleRawReceivedData()
    B->>B: processPacket()
    B->>B: Detects PUBKEY_EXCHANGE prefix
    B->>B: remotePublicKeyHex = pubKeyA
    B->>B: remoteDeviceId = idA
    B->>B: handshakeCompleted = true
    B->>B: handshakeCallbacks.forEach(cb => cb())
    
    B->>B: establishHandshake() [reply]
    B->>A: PUBKEY_EXCHANGE:<pubKeyB>:<idB>:<nameB>\n
    
    A->>A: handleRawReceivedData()
    A->>A: processPacket()
    A->>A: handshakeCompleted = true
    A->>A: handshakeCallbacks.forEach(cb => cb())
    
    Note over A,B: Both sides now have remote public key
    Note over A,B: Can derive shared secret via ECDH
    Note over A,B: Secure channel ready
```

### 5.3 Packet Processing

> Source: `secure-transport.ts:156-222`

```mermaid
flowchart TD
    A[Incoming data] --> B{Starts with PUBKEY_EXCHANGE?}
    B -->|Yes| C[Handshake packet]
    C --> D[Extract remote public key, device ID, display name]
    D --> E[handshakeCompleted = true]
    E --> F[Reply with own handshake]
    F --> G[Trigger handshakeCallbacks]
    
    B -->|No| H{Starts with chat_file_chunk?}
    H -->|Yes| I[Raw file chunk]
    I --> J[Pass to onMessageCallback unencrypted]
    
    H -->|No| K{handshakeCompleted?}
    K -->|No| L[Drop packet]
    K -->|Yes| M[Encrypted JSON packet]
    M --> N[Parse JSON envelope]
    N --> O[Convert base64 fields to Uint8Array]
    O --> P[verifyAndDecrypt]
    P --> Q{Signature valid?}
    Q -->|No| R[Throw error]
    Q -->|Yes| S[Decrypt AES-256-GCM]
    S --> T[Pass plaintext to onMessageCallback]
```

### 5.4 Buffer Management

> Source: `secure-transport.ts:132-154`

```typescript
private static readonly MAX_BUFFER_SIZE = 8 * 1024 * 1024; // 8 MB

private handleRawReceivedData(data: Uint8Array): void {
  const chunkStr = bytesToStr(data);
  this.rxBuffer += chunkStr;

  // Guard against runaway buffer growth
  if (this.rxBuffer.length > SecureTransport.MAX_BUFFER_SIZE) {
    console.error('[Secure Transport] rxBuffer exceeded 8MB limit. Clearing buffer to prevent OOM.');
    this.rxBuffer = '';
    return;
  }

  let newlineIndex: number;
  while ((newlineIndex = this.rxBuffer.indexOf('\n')) !== -1) {
    const line = this.rxBuffer.substring(0, newlineIndex);
    this.rxBuffer = this.rxBuffer.substring(newlineIndex + 1);

    if (line.trim() !== '') {
      this.processPacket(line);
    }
  }
}
```

**Protocol**: Newline-delimited JSON. Each packet ends with `\n`.

**Buffer limit**: 8 MB max. If exceeded, buffer is cleared to prevent OOM.

---

## 6. Peer Connection Manager

### 6.1 Connection State Machine

> Source: `PeerConnectionManager.ts:7-14`

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> discovered : onPeerDiscovered
    discovered --> handshake_initiated : initiateHandshake()
    
    handshake_initiated --> connected : handshake success
    handshake_initiated --> handshake_initiated : retry (≤5 attempts)
    handshake_initiated --> idle : max retries / abort
    
    connected --> lost : onPeerLost
    connected --> idle : teardown
    
    lost --> discovered : peer rediscovered (within 3s grace)
    lost --> cleaning_up : 3s grace period expires
    lost --> idle : teardown
    
    cleaning_up --> idle : cleanup complete
    
    handshake_initiated --> idle : peer lost (abort)
```

### 6.2 Handshake Sequence

> Source: `PeerConnectionManager.ts:112-203`

```mermaid
sequenceDiagram
    participant PR as PeerRegistry
    participant PCM as PeerConnectionManager
    participant WD as WifiDirectTransport
    participant RT as AndroidWifiP2PTransport
    participant ST as SecureTransport
    participant CS as ChatService

    PR->>PCM: onPeerDiscovered(peer)
    Note over PCM: Skip if already connected/handshaking
    Note over PCM: Debounce if failure < 5s ago
    PCM->>PCM: setState('discovered')
    PCM->>PCM: initiateHandshake(deviceId)
    PCM->>PCM: setState('handshake_initiated', attempt=1)
    
    PCM->>PCM: resolveMacAddress(deviceId)
    Note over PCM: 3-tier strategy:<br/>1. WiFi Direct peer list<br/>2. BLE compound key<br/>3. Fresh rediscover
    PCM->>WD: connectToPeer(macAddress)
    WD-->>PCM: waitConnectionInfo()
    Note over PCM: 30s timeout via AbortController
    
    alt I am Group Owner
        PCM->>PCM: setState('idle') — wait for inbound
    else I am client
        PCM->>RT: new AndroidWifiP2PTransport()
        PCM->>RT: connectToSocket(groupOwnerAddress, 8888)
        PCM->>ST: secureTransportFactory(rawTransport, localDeviceId)
        PCM->>ST: receive(messageHandler)
        PCM->>ST: onHandshakeReady(callback)
        PCM->>ST: establishHandshake()
        ST-->>PCM: onHandshakeReady fires
        PCM->>PCM: setState('connected')
        PCM->>CS: registerSecureTransport(secureTransport)
        PCM->>CS: registerActiveTransport(deviceId, secureTransport)
    end
```

### 6.3 Retry Logic

> Source: `PeerConnectionManager.ts:205-233`

**Max retries**: 5 attempts

**Exponential backoff**: `[200, 400, 800, 1600, 3200]` ms

```typescript
const backoffDelays = [200, 400, 800, 1600, 3200];
const delay = backoffDelays[attempt - 1] || 3200;
```

**Fast-reconnect debounce**: If last failure was <5s ago, skip re-initiation.

### 6.4 Grace Period on Peer Lost

> Source: `PeerConnectionManager.ts:307-334`

If peer is `connected` and disappears:
- Start 3-second grace period timer
- If peer rediscovered before timer fires → cancel cleanup, preserve connection
- If timer expires → teardown connection

### 6.5 MAC Address Resolution

> Source: `PeerConnectionManager.ts:235-273`

3-tier strategy to resolve BLE device ID → Wi-Fi Direct MAC address:

1. **WiFi Direct peer list**: Match by `deviceName` or `deviceAddress`
2. **BLE compound key**: `${firstWordOfName}:${idPrefix}` → trigger `rediscoverAndWait(2000)` → match WiFi Direct peer by name
3. **Fallback**: Fresh `rediscoverAndWait(2000)` → scan all results

---

## 7. Timings Summary

| Operation | Duration | Source |
|-----------|----------|--------|
| BLE scan cycle | 35 seconds | `ble-scanner.ts:100` |
| Handshake rate limit | 3 seconds | `secure-transport.ts:68` |
| Handshake timeout | 30 seconds | `PeerConnectionManager.ts:130` |
| Retry backoff | 200ms → 3200ms | `PeerConnectionManager.ts:216` |
| Max retry attempts | 5 | `PeerConnectionManager.ts:210` |
| Peer lost grace period | 3 seconds | `PeerConnectionManager.ts:321` |
| Fast-reconnect debounce | 5 seconds | `PeerConnectionManager.ts:296` |
| Buffer max size | 8 MB | `secure-transport.ts:132` |
| Heartbeat interval | 10 seconds | `ChatService.ts:161` |
| Peer silence timeout | 25 seconds | `ChatService.ts:123` |
| Handshake stale timeout | 30 seconds | `ChatService.ts:97` |

---

## 8. iOS Support

> Source: `multipeer/multipeer-transport.ios.ts`

**Status**: Stub only. No native bridge implemented.

The file exists but contains no functional implementation. iOS Multipeer Connectivity framework integration is pending.

---

## 9. Flags & TODOs

| Issue | Location | Description |
|-------|----------|-------------|
| **Test company ID** | `ble-scanner.ts:145` | Uses `0xFFFF` (test/development). Production needs registered BLE company ID. |
| **iOS stub** | `multipeer-transport.ios.ts` | No implementation. iOS support incomplete. |
| **Missing PeerRegistry** | `PeerConnectionManager.ts:4` | Imports `PeerRegistry` but file not found in codebase. |
| **Missing rediscoverAndWait** | `PeerConnectionManager.ts:254, 264` | Calls `wifiDirectTransport.rediscoverAndWait()` but method not found in `AndroidWifiP2PTransport`. |
| **No legacy device support** | `ble-scanner.ts:145` | Only accepts exactly 27 bytes with `0xFFFF` company ID. |
| **Unused service UUID** | `ble-types.ts` | `DISASTER_P2P_SERVICE_UUID` defined but not used in scanner/advertiser. |
| **Inbound GO handshake path** | `PeerConnectionManager.ts:151-154` | Group Owner sets state to `idle` and waits for inbound, but no code handles inbound connections. |

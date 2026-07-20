# Logging System

## Overview

Unified, color-coded, feature-tagged logging system for the disaster P2P mobile app. All log output from JS and native-bridge events surfaces under the `ReactNativeJS` logcat tag, visible via:

```bash
adb logcat -s ReactNativeJS
```

For color-coded output in terminal:

```bash
adb logcat -s ReactNativeJS -v color
```

## Architecture

- **Module**: `src/utils/logger.ts`
- **No third-party logging dependency** — lightweight custom wrapper
- **File output**: On-device structured JSON logs via `expo-file-system`
- **All native events** (BLE, TCP, Wi-Fi Direct) are logged at the JS boundary where `NativeEventEmitter` callbacks arrive, ensuring everything funnels through `ReactNativeJS` in logcat

## Log Levels

| Level | Priority | Console Method | Logcat Priority | Use For |
|-------|----------|----------------|-----------------|---------|
| ERROR | 0 | `console.error` | E | Crashes, unrecoverable failures |
| WARN  | 1 | `console.warn`  | W | Degraded behavior, retries, timeouts |
| INFO  | 2 | `console.info`  | I | State transitions, connection events |
| DEBUG | 3 | `console.debug` | D | Verbose diagnostics, per-packet details |

### Controlling Verbosity

```typescript
import { setLogLevel, getLogLevel } from '../utils/logger';

setLogLevel('ERROR');  // Release builds: only errors
setLogLevel('WARN');   // Default for release
setLogLevel('DEBUG');  // Default for __DEV__ builds
```

Default: `DEBUG` in `__DEV__`, `WARN` in release.

## Feature Tags

| Tag | Owner | Subsystem |
|-----|-------|-----------|
| `[BLE]` | BLE team | Scan, advertise, permissions, device discovery |
| `[TCP]` | Backend/transports | Wi-Fi Direct TCP sockets, server/client |
| `[P2P]` | Backend/transports | Peer connection lifecycle, group formation, relay |
| `[SEC]` | Crypto/backend | Handshake, key exchange, encrypt/decrypt state |
| `[CHAT]` | Chat feature | Message send/receive, delivery ack, file transfers |
| `[DB]` | Database designer | WatermelonDB queries, migrations, setup |
| `[UI]` | UI team | Screen renders, navigation |
| `[MAP]` | UI/map team | Location tracking, peer pins |
| `[SOS]` | SOS feature | Emergency alerts, assignment |
| `[AUTH]` | Auth | Login, logout, key generation |
| `[SYS]` | System | Bootstrap, app state, file logging |

## Usage

### Import

```typescript
import { logger } from '../utils/logger';
```

### API Shape

Each feature tag exposes four methods:

```typescript
logger.<tag>.error(message: string, data?: object)
logger.<tag>.warn(message: string, data?: object)
logger.<tag>.info(message: string, data?: object)
logger.<tag>.debug(message: string, data?: object)
```

### Per-Feature Usage Examples

#### Database Designer (`logger.db`)

```typescript
import { logger } from '../utils/logger';

// Migration
logger.db.info('Migration started', { fromVersion: 2, toVersion: 3 });
logger.db.error('Migration failed', { table: 'messages', error: 'column mismatch' });

// Queries
logger.db.debug('Query executed', { table: 'known_peers', count: 12, where: 'trust_status=trusted' });
logger.db.warn('Slow query detected', { table: 'messages', elapsed: 450, count: 500 });

// Setup
logger.db.info('Database initialized', { adapter: 'sqlite', tables: 6 });
logger.db.error('Database setup failed', { error: 'corrupt schema' });
```

#### BLE Feature Owner (`logger.ble`)

```typescript
import { logger } from '../utils/logger';

// Scanning lifecycle
logger.ble.info('Scan started', { mode: 'periodic', interval: 35000 });
logger.ble.info('Scan stopped');
logger.ble.debug('Match found', { mac: device.id, rssi: device.rssi });
logger.ble.error('Scan error', { code: error.code, message: error.message });

// Advertising
logger.ble.info('Advertising started', { role: 'responder', deviceId: deviceId.substring(0, 8) });
logger.ble.info('Advertising stopped');
logger.ble.error('Failed to start advertising', { error: String(err) });

// Permissions
logger.ble.warn('BLE permissions denied', { results });
```

#### TCP / Transport Owner (`logger.tcp`)

```typescript
import { logger } from '../utils/logger';

// Socket lifecycle
logger.tcp.info('Opening ServerSocket', { port: 8888 });
logger.tcp.info('ServerSocket listening', { port: 8888 });
logger.tcp.info('Connecting TCP socket', { ipAddress: '192.168.49.1', port: 8888 });
logger.tcp.info('TCP connection established');
logger.tcp.info('TCP socket disconnected');

// Data flow
logger.tcp.debug('Data received', { bytes: 1024 });
logger.tcp.error('Send failed', { error: 'socket closed', peerId: 'abc123' });
logger.tcp.warn('Reconnecting', { attempt: 3, delay: 2000 });
```

#### P2P / Backend Owner (`logger.p2p`)

```typescript
import { logger } from '../utils/logger';

// Peer connection lifecycle
logger.p2p.info('Handshake initiated', { peerId: deviceId.slice(0, 8), attempt: 1 });
logger.p2p.info('Handshake completed', { peerId: deviceId.slice(0, 8) });
logger.p2p.warn('Handshake timed out', { peerId: deviceId.slice(0, 8) });
logger.p2p.error('Handshake failed', { peerId: deviceId.slice(0, 8), error: String(err) });

// Group formation
logger.p2p.info('I am Group Owner, opening server socket');
logger.p2p.info('I am Client, targeting Group Owner', { ownerAddress: '192.168.49.1' });
logger.p2p.debug('Connection Info Event received', { groupFormed: true, isGroupOwner: false });

// Retry / self-healing
logger.p2p.info('Retrying handshake', { peerId: deviceId.slice(0, 8), attempt: 2, delay: 400 });
logger.p2p.warn('Peer silent for >25s, pruning transport', { peerId });
logger.p2p.info('Self-healing: triggering handshake retry');

// Relay
logger.p2p.debug('Hub relay: forwarding packet', { type: 'chat', relayToId });
```

#### Chat Feature Owner (`logger.chat`)

```typescript
import { logger } from '../utils/logger';

// Message send/receive
logger.chat.info('Message sent', { messageId, recipientId, hasAttachment: !!attachment });
logger.chat.info('Incoming message written to DB', { id: saved.id, senderId });
logger.chat.debug('Duplicate message received, dropped', { id, senderId });

// Delivery tracking
logger.chat.debug('Message marked as delivered', { messageId });
logger.chat.warn('Failed to send delivery ack', { messageId, error: String(err) });

// File transfers
logger.chat.info('File transfer started', { messageId, fileName, totalChunks: 12 });
logger.chat.debug('Transfer progress', { messageId: messageId.substring(0, 8), progress: 45 });
logger.chat.info('File transfer completed', { fileName, totalChunks: 12 });

// Retries
logger.chat.info('Retrying pending messages', { peerId, count: 3 });
logger.chat.warn('Retry failed', { messageId, error: String(err) });

// Heartbeat / transport health
logger.chat.warn('Peer silent for >25s, pruning transport', { peerId });
logger.chat.warn('Heartbeat ping failed', { peerId, error: String(err) });
```

#### Crypto / Secure Transport Owner (`logger.sec`)

```typescript
import { logger } from '../utils/logger';

// Handshake
logger.sec.info('Initiating P2P public key exchange');
logger.sec.info('Handshake complete', { remoteId, displayName });
logger.sec.debug('Handshake request rate-limited (cooldown active)');

// Errors
logger.sec.error('Error decrypting or verifying signature', { error: String(err) });
logger.sec.warn('Received data before identity exchange completed, packet dropped');
logger.sec.error('rxBuffer exceeded 8MB limit, clearing to prevent OOM');
```

#### UI Team (`logger.ui`)

```typescript
import { logger } from '../utils/logger';

// Screen lifecycle
logger.ui.info('Screen mounted', { screen: 'ChatScreen' });
logger.ui.debug('Screen rendered', { screen: 'MapScreen', peerCount: 5 });
logger.ui.warn('Navigation failed', { from: 'ChatScreen', to: 'MapScreen', error: String(err) });

// User interactions
logger.ui.debug('Button pressed', { screen: 'ChatScreen', action: 'sendMessage' });
```

#### Auth (`logger.auth`)

```typescript
import { logger } from '../utils/logger';

logger.auth.info('Login started', { role: 'user', displayName });
logger.auth.info('Login completed', { deviceId: deviceId.substring(0, 8) });
logger.auth.warn('Private key not found in SecureStore, logging out');
logger.auth.info('Logout completed');
```

#### Map / Location (`logger.map`)

```typescript
import { logger } from '../utils/logger';

logger.map.info('Location tracking started', { accuracy: 'balanced' });
logger.map.warn('getCurrentPositionAsync failed, trying last known position', { error: String(err) });
logger.map.debug('Broadcasted coordinate update to peer', { peerId });
logger.map.warn('Failed to share location with peer', { peerId, error: String(err) });
```

#### SOS (`logger.sos`)

```typescript
import { logger } from '../utils/logger';

logger.sos.info('SOS broadcast started', { severity: 'critical', peerCount: 3 });
logger.sos.warn('Failed to broadcast SOS to peer', { peerId, error: String(err) });
logger.sos.info('SOS assignment sent', { sosId, rescuerId });
```

### Custom Thread Labels

For code running in a specific worker or native bridge context:

```typescript
const tcpWorker = logger.withThread('TCP', 'native-tcp-socket');
tcpWorker.info('Data received', { bytes: 1024 });
// Output: [TCP] (native-tcp-socket) Data received | {"bytes":1024}
```

### Runtime Log Level Control

```typescript
import { setLogLevel, getLogLevel } from '../utils/logger';

setLogLevel('ERROR');  // Release builds: only errors
setLogLevel('WARN');   // Default for release
setLogLevel('DEBUG');  // Default for __DEV__ builds

const current = getLogLevel(); // Returns current level string
```

Default: `DEBUG` in `__DEV__`, `WARN` in release.

## Real-World Log Flow Examples

### BLE Discovery → TCP Connection → Handshake → Chat Message

This is what a complete peer-to-peer flow looks like in logcat:

```bash
adb logcat -s ReactNativeJS -v color
```

```
2026-07-20T14:30:01.123Z INFO  [BLE]  (js-ble) Advertising started | {"role":"user","deviceId":"a1b2c3d4"}
2026-07-20T14:30:01.456Z INFO  [BLE]  (js-ble) Periodic scanning started
2026-07-20T14:30:02.789Z DEBUG [BLE]  (js-ble) Match found | {"mac":"AA:BB:CC:DD:EE:FF","rssi":-65}
2026-07-20T14:30:03.012Z DEBUG [P2P]  (js-p2p) BLE map updated: 'alice:a1b2c3d4' => a1b2c3d4
2026-07-20T14:30:03.234Z DEBUG [P2P]  (js-p2p) Triggering native Wi-Fi Direct peer discovery (throttled)
2026-07-20T14:30:04.567Z DEBUG [P2P]  (js-p2p) Wi-Fi Direct peers changed | {"count":2}
2026-07-20T14:30:04.890Z DEBUG [P2P]  (js-p2p) Candidate 'Alice Phone' resolved via BLE map | {"bleRemoteId":"a1b2c3d4","isInitiator":true}
2026-07-20T14:30:05.123Z INFO  [P2P]  (js-p2p) Selected target peer for Wi-Fi Direct connection | {"name":"Alice Phone","address":"AA:BB:CC:DD:EE:FF"}
2026-07-20T14:30:05.456Z DEBUG [P2P]  (js-p2p) Native connectToPeer resolved, waiting for Group Formation
2026-07-20T14:30:06.789Z DEBUG [P2P]  (js-p2p) Connection Info Event received | {"groupFormed":true,"isGroupOwner":false,"ownerAddr":"192.168.49.1"}
2026-07-20T14:30:07.012Z INFO  [P2P]  (js-p2p) I am Client, targeting Group Owner | {"ownerAddress":"192.168.49.1"}
2026-07-20T14:30:07.345Z DEBUG [TCP]  (js-tcp) Connecting TCP socket | {"ipAddress":"192.168.49.1","port":8888}
2026-07-20T14:30:08.678Z INFO  [TCP]  (js-tcp) TCP connection established to group owner
2026-07-20T14:30:08.901Z INFO  [P2P]  (js-p2p) Client establishing secure transport handshake
2026-07-20T14:30:09.234Z INFO  [SEC]  (js-sec) Initiating P2P public key exchange
2026-07-20T14:30:10.567Z INFO  [SEC]  (js-sec) Handshake complete | {"remoteId":"e5f6g7h8","displayName":"Alice"}
2026-07-20T14:30:10.890Z INFO  [P2P]  (js-p2p) Handshake completed for peer e5f6g7h8
2026-07-20T14:30:11.123Z DEBUG [P2P]  (js-p2p) [owner-socket-1234567890] Handshake completed, registering transport for peer e5f6g7h8
2026-07-20T14:30:15.456Z DEBUG [P2P]  (js-p2p) [owner-socket-1234567890] Encrypted payload decrypted, type=chat
2026-07-20T14:30:15.789Z DEBUG [CHAT] (js-chat) Incoming message written to DB | {"id":"msg-uuid-123","senderId":"e5f6g7h8"}
2026-07-20T14:30:16.012Z DEBUG [CHAT] (js-chat) Message marked as delivered | {"messageId":"msg-uuid-123"}
```

### File Transfer Flow

```
2026-07-20T14:35:01.123Z INFO  [CHAT] (js-chat) File transfer started | {"messageId":"msg-uuid-456","fileName":"photo.jpg","totalChunks":12}
2026-07-20T14:35:01.456Z DEBUG [CHAT] (js-chat) Transfer progress | {"messageId":"msg-uuid","progress":8}
2026-07-20T14:35:02.789Z DEBUG [CHAT] (js-chat) Transfer progress | {"messageId":"msg-uuid","progress":25}
2026-07-20T14:35:04.012Z DEBUG [CHAT] (js-chat) Transfer progress | {"messageId":"msg-uuid","progress":50}
2026-07-20T14:35:05.345Z DEBUG [CHAT] (js-chat) Transfer progress | {"messageId":"msg-uuid","progress":75}
2026-07-20T14:35:06.678Z DEBUG [CHAT] (js-chat) Transfer progress | {"messageId":"msg-uuid","progress":100}
2026-07-20T14:35:07.901Z INFO  [CHAT] (js-chat) File transfer completed | {"fileName":"photo.jpg","totalChunks":12}
```

### Error / Retry Flow

```
2026-07-20T14:40:01.123Z WARN  [P2P]  (js-p2p) Handshake timed out for peer a1b2c3d4
2026-07-20T14:40:01.456Z INFO  [P2P]  (js-p2p) Retrying handshake | {"peerId":"a1b2c3d4","attempt":2,"delay":400}
2026-07-20T14:40:02.789Z WARN  [P2P]  (js-p2p) Handshake failed | {"peerId":"a1b2c3d4","error":"socket closed"}
2026-07-20T14:40:03.012Z INFO  [P2P]  (js-p2p) Retrying handshake | {"peerId":"a1b2c3d4","attempt":3,"delay":800}
2026-07-20T14:40:04.345Z INFO  [P2P]  (js-p2p) Handshake completed for peer a1b2c3d4
```

### Self-Healing / Heartbeat Flow

```
2026-07-20T14:45:01.123Z WARN  [CHAT] (js-chat) Peer silent for >25s, pruning transport | {"peerId":"e5f6g7h8"}
2026-07-20T14:45:01.456Z INFO  [P2P]  (js-p2p) All connections gone, resetting group state and triggering P2P cleanup
2026-07-20T14:45:02.789Z INFO  [P2P]  (js-p2p) P2P cleanup starting (All Clients Disconnected)
2026-07-20T14:45:05.012Z INFO  [BLE]  (js-ble) Periodic scanning started
2026-07-20T14:45:06.345Z DEBUG [BLE]  (js-ble) Match found | {"mac":"AA:BB:CC:DD:EE:FF","rssi":-70}
2026-07-20T14:45:07.678Z INFO  [P2P]  (js-p2p) Self-healing: triggering handshake retry
```

## Output Format

### Logcat (terminal)

```
2026-07-20T14:32:01.123Z INFO  [BLE]  (js-ble) Periodic scanning started
2026-07-20T14:32:01.456Z DEBUG [TCP]  (js-tcp) Connecting TCP socket | {"ipAddress":"192.168.49.1","port":8888}
2026-07-20T14:32:02.789Z WARN  [P2P]  (js-p2p) Handshake timed out for peer abc12345
2026-07-20T14:32:03.012Z ERROR [SEC]  (js-sec) Error decrypting or verifying signature | {"error":"..."}
```

ANSI color codes are embedded in the message body:
- ERROR: Red
- WARN: Yellow
- INFO: Cyan
- DEBUG: Gray

### File Output

Structured JSON lines written to on-device storage:

```
{documentDirectory}/logs/app-2026-07-20.log
```

Each line:

```json
{"ts":"2026-07-20T14:32:01.123Z","level":"INFO","feature":"BLE","thread":"js-ble","msg":"Periodic scanning started"}
```

File logging is enabled at service bootstrap. Logs rotate daily by date.

### Retrieving On-Device Logs

```typescript
import { logger } from '../utils/logger';

const path = await logger.exportLogs();
// Returns file path like /data/user/0/com.app/files/logs/app-2026-07-20.log
```

Or via ADB:

```bash
adb shell "run-as com.your.app cat files/logs/app-2026-07-20.log" > local-copy.log
```

## Filtering Examples

```bash
# Only BLE logs
adb logcat -s ReactNativeJS | grep "\[BLE\]"

# Only errors and warnings
adb logcat -s ReactNativeJS *:W

# Chat + TCP flow
adb logcat -s ReactNativeJS | grep -E "\[(CHAT|TCP)\]"

# All P2P connection lifecycle
adb logcat -s ReactNativeJS | grep "\[P2P\]"
```

## Security Constraints

The logger **never** writes to logs:
- Private keys or key material
- Message plaintext content (only metadata: IDs, types, state transitions)
- Personal identifiable information

Chat/crypto logging captures:
- Connection state transitions (handshake started/complete/failed)
- Message IDs, sender/recipient IDs, sync status
- File transfer metadata (file name, type, chunk count, progress %)
- Error types and retry counts

## Quick Reference: Common Debugging Scenarios

### "Why isn't my peer connecting?"

```bash
# Watch the full connection flow
adb logcat -s ReactNativeJS | grep -E "\[(BLE|P2P|TCP|SEC)\]"

# Or filter to just the handshake
adb logcat -s ReactNativeJS | grep -E "\[(P2P|SEC)\]" | grep -i "handshake"
```

Look for:
- `[BLE] Match found` — peer discovered
- `[P2P] Selected target peer` — initiator decision
- `[TCP] TCP connection established` — socket connected
- `[SEC] Handshake complete` — crypto handshake done
- `[P2P] Handshake completed for peer` — transport registered

### "Why isn't my message being delivered?"

```bash
# Watch chat message flow
adb logcat -s ReactNativeJS | grep "\[CHAT\]"

# Or watch the full send/receive path
adb logcat -s ReactNativeJS | grep -E "\[(CHAT|P2P|SEC)\]"
```

Look for:
- `[CHAT] Message sent` — optimistic write to DB
- `[P2P] Encrypted payload decrypted, type=chat` — payload received
- `[CHAT] Incoming message written to DB` — receiver wrote to DB
- `[CHAT] Message marked as delivered` — ACK received
- `[CHAT] Duplicate message received, dropped` — dedup working

### "Why did the file transfer fail?"

```bash
# Watch file transfer progress
adb logcat -s ReactNativeJS | grep "\[CHAT\]" | grep -i "transfer\|chunk"
```

Look for:
- `[CHAT] File transfer started` — metadata sent
- `[CHAT] Transfer progress` — chunk-by-chunk progress
- `[CHAT] File transfer completed` — all chunks received
- `[CHAT] Transfer progress cleared` — cleanup done

### "Why is the connection dropping?"

```bash
# Watch connection health
adb logcat -s ReactNativeJS | grep -E "\[(P2P|TCP|CHAT)\]" | grep -i "disconnect\|timeout\|silent\|error"
```

Look for:
- `[TCP] TCP socket disconnected` — socket closed
- `[CHAT] Peer silent for >25s, pruning transport` — heartbeat timeout
- `[P2P] All connections gone, resetting group state` — full cleanup
- `[P2P] Handshake timed out` — crypto handshake failed

### "Why isn't BLE scanning working?"

```bash
# Watch BLE subsystem
adb logcat -s ReactNativeJS | grep "\[BLE\]"
```

Look for:
- `[BLE] Advertising started` — broadcasting identity
- `[BLE] Periodic scanning started` — listening for peers
- `[BLE] Match found` — peer discovered
- `[BLE] BLE permissions denied` — permission issue
- `[BLE] Failed to start advertising` — Bluetooth off or unsupported

### "I need the full logs for a bug report"

```bash
# Pull on-device structured logs
adb shell "run-as com.your.app cat files/logs/app-$(date +%Y-%m-%d).log" > bug-report.log

# Or capture live logcat with timestamps
adb logcat -s ReactNativeJS -v time > live-capture.log
```

## Adding Logging to New Code

1. Import the logger: `import { logger } from '../utils/logger';`
2. Pick the appropriate feature tag (`logger.ble`, `logger.tcp`, `logger.chat`, etc.)
3. Pick the appropriate level:
   - `error` — something broke that the user/team needs to know about
   - `warn` — degraded but functional, retry happening
   - `info` — meaningful state transition (connected, disconnected, handshake done)
   - `debug` — verbose per-event detail (packet received, scan tick, query result)
4. Pass structured data as the second argument (not string interpolation):

```typescript
logger.chat.info('Message sent', { messageId, recipientId, hasAttachment: !!attachment });
```

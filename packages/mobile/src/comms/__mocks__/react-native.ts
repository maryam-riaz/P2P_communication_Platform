/**
 * Jest mock for react-native in Node.js test environment.
 *
 * The transport tests run entirely in Node.js. This mock prevents Jest from
 * parsing React Native's ESM-only index.js, while providing working TCP socket
 * bridging via Node's built-in `net` module so the full P2P pipeline can be
 * tested end-to-end.
 *
 * ── Socket Architecture ─────────────────────────────────────────────────────
 * Two independent listener channels exist:
 *   _serverDataListeners    — receive data sent BY the client (via _clientSocket.write)
 *   _clientDataListeners    — receive data sent BY the server (via _serverSocket.write)
 *
 * Side assignment (server vs client) is determined lazily on the first
 * WifiDirectTcp* event registration per emitter instance. The first emitter
 * that registers a TCP event becomes the "server" side, the second becomes the
 * "client" side. System-level P2P events (WifiDirectPeersChanged etc.) are
 * pass-through no-ops in the test environment.
 */

import * as net from 'net';

// ── Shared TCP socket state ──────────────────────────────────────────────────
let _server: net.Server | null = null;
let _serverSocket: net.Socket | null = null; // accepted by the server
let _clientSocket: net.Socket | null = null; // opened by the client

// Server-side listeners: data sent BY the client arrives here
const _serverDataListeners: Array<(b64: string) => void> = [];
const _serverConnectedListeners: Array<() => void> = [];
const _serverDisconnectedListeners: Array<() => void> = [];

// Client-side listeners: data sent BY the server arrives here
const _clientDataListeners: Array<(b64: string) => void> = [];
const _clientConnectedListeners: Array<() => void> = [];
const _clientDisconnectedListeners: Array<() => void> = [];

// ── Side-assignment tracking ─────────────────────────────────────────────────
// Assigned lazily when the first TCP event is registered per emitter instance.
const _tcpSideAssignments = new Map<object, 'server' | 'client'>();
let _tcpSideCount = 0;

function _assignSide(self: object): 'server' | 'client' {
  if (!_tcpSideAssignments.has(self)) {
    const side: 'server' | 'client' = _tcpSideCount % 2 === 0 ? 'server' : 'client';
    _tcpSideAssignments.set(self, side);
    _tcpSideCount++;
  }
  return _tcpSideAssignments.get(self)!;
}

// ── WifiDirect native module mock ────────────────────────────────────────────
const WifiDirectMock = {
  initialize: jest.fn().mockResolvedValue(undefined),
  cleanup: jest.fn().mockResolvedValue(undefined),
  discoverPeers: jest.fn().mockResolvedValue(undefined),
  requestPeers: jest.fn().mockResolvedValue([]),
  connectToPeer: jest.fn().mockResolvedValue(undefined),
  getConnectionInfo: jest.fn().mockResolvedValue({
    groupOwnerAddress: '127.0.0.1',
    isGroupOwner: true,
    groupFormed: true,
  }),
  disconnect: jest.fn().mockResolvedValue(undefined),
  deletePersistentGroups: jest.fn().mockResolvedValue(true),
  cancelConnect: jest.fn().mockResolvedValue(true),
  isWifiEnabled: jest.fn().mockResolvedValue(true),
  setWifiEnabled: jest.fn().mockResolvedValue(true),
  setBluetoothEnabled: jest.fn().mockResolvedValue(true),

  /** Opens a TCP server. Resolves when bound. Fires WifiDirectTcpConnected on accept. */
  openServerSocket: jest.fn().mockImplementation((port: number) => {
    return new Promise<void>((resolve, reject) => {
      _server = net.createServer((sock) => {
        _serverSocket = sock;
        // Notify server-side transport a client connected
        _serverConnectedListeners.forEach((fn) => fn());
        // Data arriving at server = sent BY the client
        sock.on('data', (buf) => {
          const b64 = buf.toString('base64');
          _serverDataListeners.forEach((fn) => fn(b64));
        });
        sock.on('close', () => _serverDisconnectedListeners.forEach((fn) => fn()));
        sock.on('error', () => _serverDisconnectedListeners.forEach((fn) => fn()));
      });
      _server!.listen(port, '127.0.0.1', () => resolve());
      _server!.on('error', reject);
    });
  }),

  /** Connects as TCP client. Resolves when connected. */
  connectToSocket: jest.fn().mockImplementation((ip: string, port: number) => {
    return new Promise<void>((resolve, reject) => {
      _clientSocket = new net.Socket();
      _clientSocket.connect(port, ip, () => resolve());
      // Data arriving at client = sent BY the server
      _clientSocket.on('data', (buf) => {
        const b64 = buf.toString('base64');
        _clientDataListeners.forEach((fn) => fn(b64));
      });
      _clientSocket.on('close', () => _clientDisconnectedListeners.forEach((fn) => fn()));
      _clientSocket.on('error', reject);
    });
  }),

  /**
   * Sends base64-encoded bytes in the correct direction:
   *   isServer=true  → server writes to _serverSocket → client reads it
   *   isServer=false → client writes to _clientSocket → server reads it
   */
  tcpSend: jest.fn().mockImplementation((base64: string, isServer: boolean) => {
    return new Promise<void>((resolve, reject) => {
      const buf = Buffer.from(base64, 'base64');
      const sock = isServer ? _serverSocket : _clientSocket;
      if (!sock) return reject(new Error(`tcpSend: no ${isServer ? 'server' : 'client'} socket open`));
      sock.write(buf, (err: any) => (err ? reject(err) : resolve()));
    });
  }),

  /** Closes sockets and server. */
  tcpDisconnect: jest.fn().mockImplementation(() => {
    return new Promise<void>((resolve) => {
      _serverSocket?.destroy();
      _clientSocket?.destroy();
      _server?.close();
      _serverSocket = null;
      _clientSocket = null;
      _server = null;
      resolve();
    });
  }),
};

export const NativeModules = {
  BleAdvertiser: {
    startAdvertising: jest.fn().mockResolvedValue({ capability: 'extended' }),
    stopAdvertising: jest.fn().mockResolvedValue(undefined),
    getAdvertisingCapabilities: jest.fn().mockResolvedValue({
      canAdvertise: true,
      supportsExtended: true,
      isCurrentlyAdvertising: false,
      currentCapability: 'scan_only',
    }),
  },
  WifiDirect: WifiDirectMock,
};

/**
 * NativeEventEmitter mock — routes WifiDirect TCP events to the correct
 * side-specific listener arrays.
 *
 * Side assignment is determined lazily: the first emitter to register a
 * WifiDirectTcp* event becomes "server"; the second becomes "client".
 * Static/system events (WifiDirectPeersChanged etc.) are no-ops in tests.
 */
export const NativeEventEmitter = jest.fn().mockImplementation(() => {
  const self: object = {};

  return {
    addListener: jest.fn().mockImplementation((eventName: string, callback: (...args: any[]) => void) => {
      const isTcpEvent =
        eventName === 'WifiDirectTcpData' ||
        eventName === 'WifiDirectTcpConnected' ||
        eventName === 'WifiDirectTcpDisconnected';

      let targetDataListeners: Array<(b64: string) => void> | null = null;
      let targetConnListeners: Array<() => void> | null = null;
      let targetDiscListeners: Array<() => void> | null = null;

      if (isTcpEvent) {
        const side = _assignSide(self);
        targetDataListeners = side === 'server' ? _serverDataListeners : _clientDataListeners;
        targetConnListeners = side === 'server' ? _serverConnectedListeners : _clientConnectedListeners;
        targetDiscListeners = side === 'server' ? _serverDisconnectedListeners : _clientDisconnectedListeners;

        if (eventName === 'WifiDirectTcpData') targetDataListeners.push(callback as (b64: string) => void);
        else if (eventName === 'WifiDirectTcpConnected') targetConnListeners.push(callback as () => void);
        else if (eventName === 'WifiDirectTcpDisconnected') targetDiscListeners.push(callback as () => void);
      }
      // System events: WifiDirectPeersChanged, WifiDirectConnectionInfo — no-op in tests

      return {
        remove: jest.fn().mockImplementation(() => {
          const removeFrom = (arr: any[] | null) => {
            if (!arr) return;
            const idx = arr.indexOf(callback);
            if (idx !== -1) arr.splice(idx, 1);
          };
          removeFrom(targetDataListeners);
          removeFrom(targetConnListeners);
          removeFrom(targetDiscListeners);
        }),
      };
    }),
    removeAllListeners: jest.fn(),
  };
});

export const Platform = {
  OS: 'android',
  Version: 31,
  select: (obj: Record<string, any>) => obj.android ?? obj.default,
};

export const PermissionsAndroid = {
  PERMISSIONS: {
    ACCESS_FINE_LOCATION: 'android.permission.ACCESS_FINE_LOCATION',
    BLUETOOTH_SCAN: 'android.permission.BLUETOOTH_SCAN',
    BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT',
    BLUETOOTH_ADVERTISE: 'android.permission.BLUETOOTH_ADVERTISE',
  },
  RESULTS: {
    GRANTED: 'granted',
    DENIED: 'denied',
    NEVER_ASK_AGAIN: 'never_ask_again',
  },
  request: jest.fn().mockResolvedValue('granted'),
  requestMultiple: jest.fn().mockResolvedValue({
    'android.permission.ACCESS_FINE_LOCATION': 'granted',
    'android.permission.BLUETOOTH_SCAN': 'granted',
    'android.permission.BLUETOOTH_CONNECT': 'granted',
    'android.permission.BLUETOOTH_ADVERTISE': 'granted',
  }),
};

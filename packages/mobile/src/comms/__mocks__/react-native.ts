/**
 * Jest mock for react-native in Node.js test environment.
 *
 * The transport tests (BLE pack/unpack, TCP socket, ECDH handshake) run
 * entirely in Node.js and do not need real native modules. This mock
 * prevents Jest from trying to parse React Native's ESM-only index.js.
 */
export const NativeModules = {
  // BleAdvertiser native module — not called in transport tests
  BleAdvertiser: {
    startAdvertising: jest.fn().mockResolvedValue(undefined),
    stopAdvertising: jest.fn().mockResolvedValue(undefined),
    isAdvertisingSupported: jest.fn().mockResolvedValue(true),
  },
  // WifiDirect native module — not called in transport tests
  WifiDirect: {
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
  },
};

export const NativeEventEmitter = jest.fn().mockImplementation(() => ({
  addListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  removeAllListeners: jest.fn(),
}));

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

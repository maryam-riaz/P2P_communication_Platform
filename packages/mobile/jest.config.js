module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      tsconfig: 'tsconfig.json'
    }]
  },
  moduleNameMapper: {
    '^shared$': '<rootDir>/../shared/src',
    // Mock react-native and its sub-packages in the Node.js Jest environment.
    // The transport test only exercises the TCP socket and crypto layers,
    // not native BLE/Wi-Fi Direct APIs, so a lightweight mock suffices.
    '^react-native$': '<rootDir>/src/comms/__mocks__/react-native.ts',
    '^react-native-ble-plx$': '<rootDir>/src/comms/__mocks__/react-native-ble-plx.ts',
  }
};

/**
 * Jest mock for react-native-ble-plx in Node.js test environment.
 *
 * The transport tests exercise the BLE payload pack/unpack and TCP socket layers
 * via the existing test harness (onAdvertisementReceived). The real BleManager
 * (which wraps native Android/iOS BLE APIs) cannot run in Node.js.
 */
export class BleManager {
  startDeviceScan = jest.fn();
  stopDeviceScan = jest.fn();
  destroy = jest.fn();
  connectToDevice = jest.fn();
  state = jest.fn().mockResolvedValue('PoweredOn');
}

export class Device {
  id = '';
  name: string | null = null;
  rssi: number | null = null;
  manufacturerData: string | null = null;
}

export const BleErrorCode = {
  BluetoothUnauthorized: 3,
  BluetoothPoweredOff: 4,
};

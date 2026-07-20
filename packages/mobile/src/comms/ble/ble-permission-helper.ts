import { Platform, PermissionsAndroid } from 'react-native';
import { logger } from '../../utils/logger';

/**
 * Requests all permissions required for BLE advertising and scanning on Android.
 *
 * Android 12+ (API 31+) requires BLUETOOTH_SCAN, BLUETOOTH_CONNECT, and
 * BLUETOOTH_ADVERTISE. Older versions require ACCESS_FINE_LOCATION.
 *
 * @returns true if all required permissions were granted, false otherwise.
 */
export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    // iOS permissions are handled via Info.plist NSBluetoothAlwaysUsageDescription
    return true;
  }

  const androidVersion = parseInt(String(Platform.Version), 10);

  if (androidVersion >= 31) {
    // Android 12+ — request new granular Bluetooth permissions
    const permissions = [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ];

    if (androidVersion >= 33) {
      permissions.push('android.permission.NEARBY_WIFI_DEVICES' as any);
    }

    const results = await PermissionsAndroid.requestMultiple(permissions);

    const allGranted = Object.values(results).every(
      (status) => status === PermissionsAndroid.RESULTS.GRANTED
    );

    if (!allGranted) {
      logger.ble.warn('BLE permissions denied', { results });
    }
    return allGranted;
  } else {
    // Android 10/11 — Location permission is required for BLE scan
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title: 'Location Permission Required',
        message:
          'This app needs location permission to discover nearby emergency devices via Bluetooth.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      }
    );

    const granted = result === PermissionsAndroid.RESULTS.GRANTED;
    if (!granted) {
      logger.ble.warn('ACCESS_FINE_LOCATION denied');
    }
    return granted;
  }
}

/**
 * Returns true if the device supports BLE peripheral mode (advertising).
 * Some low-end Android devices do not support acting as a BLE peripheral.
 */
export function isBleAdvertisingSupported(): boolean {
  // react-native-ble-plx checks this at the native level.
  // On Android, BluetoothAdapter.isMultipleAdvertisementSupported() must return true.
  // This is a best-effort check; the real check happens in BleAdvertiser.startAdvertising().
  return Platform.OS === 'android' || Platform.OS === 'ios';
}

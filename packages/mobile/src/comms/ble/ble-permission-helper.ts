import { Platform, PermissionsAndroid, Permission } from 'react-native';

export interface P2pPermissionResult {
  allGranted: boolean;
  ble: { scan: boolean; connect: boolean; advertise: boolean };
  wifiDirect: boolean;
  location: boolean;
  /** human-readable string listing which permissions were denied */
  deniedSummary: string;
}

const PERMISSION_LABELS: Record<string, string> = {
  'android.permission.BLUETOOTH_SCAN': 'Bluetooth Scan',
  'android.permission.BLUETOOTH_CONNECT': 'Bluetooth Connect',
  'android.permission.BLUETOOTH_ADVERTISE': 'Bluetooth Advertise',
  'android.permission.ACCESS_FINE_LOCATION': 'Fine Location',
  'android.permission.ACCESS_COARSE_LOCATION': 'Coarse Location',
  'android.permission.NEARBY_WIFI_DEVICES': 'Nearby Wi-Fi Devices',
};

function buildDeniedSummary(results: Record<string, string>): string {
  return (Object.keys(results) as Permission[])
    .filter((perm) => results[perm] !== PermissionsAndroid.RESULTS.GRANTED)
    .map((perm) => PERMISSION_LABELS[perm] || perm)
    .join(', ');
}

export async function requestP2pPermissions(): Promise<P2pPermissionResult> {
  const empty: P2pPermissionResult = {
    allGranted: false,
    ble: { scan: false, connect: false, advertise: false },
    wifiDirect: false,
    location: false,
    deniedSummary: '',
  };

  if (Platform.OS !== 'android') {
    return { ...empty, allGranted: true };
  }

  const androidVersion = parseInt(String(Platform.Version), 10);

  if (androidVersion >= 31) {
    const permissions: Permission[] = [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ];

    const NEARBY_PERMISSION = 'android.permission.NEARBY_WIFI_DEVICES' as Permission;
    if (androidVersion >= 33) {
      permissions.push(NEARBY_PERMISSION);
    }

    const results = await PermissionsAndroid.requestMultiple(permissions);

    const scan = results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED;
    const connect = results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED;
    const advertise = results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE] === PermissionsAndroid.RESULTS.GRANTED;
    const location = results[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
    const wifiDirect = androidVersion >= 33
      ? (results[NEARBY_PERMISSION] === PermissionsAndroid.RESULTS.GRANTED)
      : true;

    const allGranted = scan && connect && advertise && location && wifiDirect;
    const deniedSummary = allGranted ? '' : buildDeniedSummary(results);

    console.log(`[P2P Permissions] API ${androidVersion}: scan=${scan} connect=${connect} advertise=${advertise} location=${location} wifi=${wifiDirect}`);

    return { allGranted, ble: { scan, connect, advertise }, wifiDirect, location, deniedSummary };
  } else {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title: 'Location Permission Required',
        message: 'This app needs location permission to discover nearby emergency devices via Bluetooth and Wi-Fi Direct.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      }
    );

    const location = result === PermissionsAndroid.RESULTS.GRANTED;
    return {
      allGranted: location,
      ble: { scan: false, connect: false, advertise: false },
      wifiDirect: true,
      location,
      deniedSummary: location ? '' : 'Fine Location',
    };
  }
}

export async function requestBlePermissions(): Promise<boolean> {
  const result = await requestP2pPermissions();
  return result.allGranted;
}

export function isBleAdvertisingSupported(): boolean {
  return Platform.OS === 'android' || Platform.OS === 'ios';
}

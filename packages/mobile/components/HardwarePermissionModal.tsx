import React, { useEffect, useState, useMemo, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Linking,
  Platform,
  PermissionsAndroid,
  AppState,
  ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import { getBleState } from '../src/comms/ble/shared-ble-manager';

// Dynamic import or fallback for native WifiDirect
let WifiDirect: any = null;
try {
  const { NativeModules } = require('react-native');
  WifiDirect = NativeModules.WifiDirect;
} catch (e) {
  console.warn('WifiDirect native module not found in mock/web context');
}

export default function HardwarePermissionModal() {
  const [permissionsGranted, setPermissionsGranted] = useState(true);
  const [wifiEnabled, setWifiEnabled] = useState(true);
  const [bluetoothEnabled, setBluetoothEnabled] = useState(true);
  const [locationEnabled, setLocationEnabled] = useState(true);
  const [checking, setChecking] = useState(true);

  // Check Android permission statuses
  const checkPermissions = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;

    try {
      if (Platform.Version >= 31) {
        const fineLocation = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
        const btScan = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
        const btConnect = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
        const btAdvertise = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE);

        let nearbyWifi = true;
        if (Platform.Version >= 33) {
          nearbyWifi = await PermissionsAndroid.check('android.permission.NEARBY_WIFI_DEVICES' as any);
        }

        return fineLocation && btScan && btConnect && btAdvertise && nearbyWifi;
      } else {
        return await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
      }
    } catch (err) {
      console.error('[HardwarePermissionModal] Failed to check permissions:', err);
      return false;
    }
  };

  const runAllChecks = async () => {
    setChecking(true);
    try {
      // 1. Check Permissions
      const permResult = await checkPermissions();
      setPermissionsGranted(permResult);

      // 2. Check Wi-Fi
      if (Platform.OS === 'android' && WifiDirect && typeof WifiDirect.isWifiEnabled === 'function') {
        const wifiResult = await WifiDirect.isWifiEnabled();
        setWifiEnabled(!!wifiResult);
      } else {
        setWifiEnabled(true);
      }

      // 3. Check Location services
      const locResult = await Location.hasServicesEnabledAsync();
      setLocationEnabled(!!locResult);

      // 4. Check Bluetooth
      const btState = await getBleState();
      setBluetoothEnabled(btState === 'on');

    } catch (err) {
      console.error('[HardwarePermissionModal] Check execution error:', err);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    runAllChecks();

    // Re-check when app returns to active foreground
    const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        runAllChecks();
      }
    });

    // Periodic check every 3 seconds to auto-react to quick toggles
    const intervalId = setInterval(() => {
      runAllChecks();
    }, 3000);

    return () => {
      appStateSubscription.remove();
      clearInterval(intervalId);
    };
  }, []);

  const isTriggeringRef = useRef(false);

  const handleOpenSettings = async () => {
    try {
      await Linking.openSettings();
    } catch (err) {
      console.error('[HardwarePermissionModal] Cannot open settings:', err);
    }
  };

  const handleEnableServices = async () => {
    try {
      if (!wifiEnabled && Platform.OS === 'android' && WifiDirect) {
        await WifiDirect.setWifiEnabled(true);
      }
      if (!bluetoothEnabled && Platform.OS === 'android' && WifiDirect) {
        await WifiDirect.setBluetoothEnabled(true);
      }
      if (!locationEnabled) {
        await Linking.openSettings();
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await runAllChecks();
    } catch (err) {
      console.error('[HardwarePermissionModal] Failed to enable services:', err);
    }
  };

  // Determine if we need to show the modal (if permissions are missing or any hardware is off)
  const isHealthy = permissionsGranted && wifiEnabled && bluetoothEnabled && locationEnabled;

  useEffect(() => {
    if (!isHealthy && permissionsGranted && !checking && !isTriggeringRef.current) {
      isTriggeringRef.current = true;
      handleEnableServices().finally(() => {
        isTriggeringRef.current = false;
      });
    }
  }, [isHealthy, permissionsGranted, checking]);

  if (isHealthy) {
    return null;
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={!isHealthy}
      onRequestClose={() => {}}
    >
      <View style={styles.overlay}>
        <View style={styles.modalContainer}>
          <Text style={styles.title}>
            {!permissionsGranted ? 'Permissions Required' : 'Action Required'}
          </Text>

          <Text style={styles.description}>
            {!permissionsGranted
              ? 'This app needs location, bluetooth, and nearby device permissions to discover and connect with peers offline.'
              : 'The app is not able to function properly if Wi-Fi, Bluetooth, or Location is turned off. Please turn them on.'}
          </Text>

          <View style={styles.statusBox}>
            <View style={styles.statusRow}>
              <Text style={styles.statusLabel}>Permissions Granted</Text>
              <Text style={[styles.statusValue, permissionsGranted ? styles.enabledText : styles.disabledText]}>
                {permissionsGranted ? '✓ Granted' : '✗ Denied'}
              </Text>
            </View>

            <View style={styles.statusRow}>
              <Text style={styles.statusLabel}>Wi-Fi Services</Text>
              <Text style={[styles.statusValue, wifiEnabled ? styles.enabledText : styles.disabledText]}>
                {wifiEnabled ? '✓ Enabled' : '✗ Disabled'}
              </Text>
            </View>

            <View style={styles.statusRow}>
              <Text style={styles.statusLabel}>Bluetooth Services</Text>
              <Text style={[styles.statusValue, bluetoothEnabled ? styles.enabledText : styles.disabledText]}>
                {bluetoothEnabled ? '✓ Enabled' : '✗ Disabled'}
              </Text>
            </View>

            <View style={styles.statusRow}>
              <Text style={styles.statusLabel}>Location Services</Text>
              <Text style={[styles.statusValue, locationEnabled ? styles.enabledText : styles.disabledText]}>
                {locationEnabled ? '✓ Enabled' : '✗ Disabled'}
              </Text>
            </View>
          </View>

          {checking && <ActivityIndicator size="small" color="#FF8C42" style={{ marginVertical: 8 }} />}

          <View style={styles.buttonContainer}>
            <TouchableOpacity 
              style={[styles.button, styles.primaryButton]} 
              onPress={!permissionsGranted ? handleOpenSettings : handleEnableServices}
            >
              <Text style={styles.primaryButtonText}>
                {!permissionsGranted ? 'Turn Permissions On' : 'Turn Services On'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={runAllChecks}>
              <Text style={styles.secondaryButtonText}>Refresh</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContainer: {
    backgroundColor: '#1E1E1E',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderColor: '#333333',
    alignItems: 'center',
  },
  title: {
    color: '#FF8C42',
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 12,
    textAlign: 'center',
  },
  description: {
    color: '#CCCCCC',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 20,
  },
  statusBox: {
    width: '100%',
    backgroundColor: '#121212',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
    gap: 8,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusLabel: {
    color: '#999999',
    fontSize: 13,
  },
  statusValue: {
    fontSize: 13,
    fontWeight: '600',
  },
  enabledText: {
    color: '#4CAF50',
  },
  disabledText: {
    color: '#F44336',
  },
  buttonContainer: {
    width: '100%',
    gap: 10,
  },
  button: {
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  primaryButton: {
    backgroundColor: '#FF8C42',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#555555',
  },
  secondaryButtonText: {
    color: '#CCCCCC',
    fontSize: 14,
  },
});

import '../src/utils/polyfills';
import { Platform, LogBox, StatusBar } from 'react-native';
import HardwarePermissionModal from '../components/HardwarePermissionModal';
import * as Crypto from 'expo-crypto';

if (__DEV__) {
  LogBox.ignoreLogs(['Unable to activate keep awake']);
  const originalConsoleError = console.error;
  console.error = (...args: any[]) => {
    if (args[0] && args[0].toString().includes('Unable to activate keep awake')) {
      console.warn('[KeepAwake Suppressed]', args[0]);
      return;
    }
    originalConsoleError(...args);
  };
}

// Polyfill crypto.getRandomValues for Expo/React Native environments (used by @noble/curves)
if (Platform.OS !== 'web' && (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function')) {
  // @ts-ignore
  globalThis.crypto = {
    ...globalThis.crypto,
    getRandomValues: (array: any) => {
      const randomBytes = Crypto.getRandomBytes(array.length);
      array.set(randomBytes);
      return array;
    }
  };
}

import { Provider } from 'react-redux';
import { store } from '../src/redux/store';
import { Slot } from 'expo-router';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { ServiceContext } from '../src/context/ServiceContext';
import { useInitializeServices } from '../src/hooks/useInitializeServices';

function AppWithServices() {
  const services = useInitializeServices();

  if (!services) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#FF8C42" />
      </View>
    );
  }

  return (
    <ServiceContext.Provider value={services}>
      <Slot />
    </ServiceContext.Provider>
  );
}

import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  return (
    <Provider store={store}>
      <SafeAreaProvider>
        <AppWithServices />
      </SafeAreaProvider>
      <HardwarePermissionModal />
      <StatusBar barStyle="light-content" />
    </Provider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000000',
  },
});
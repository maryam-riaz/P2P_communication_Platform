import 'react-native-get-random-values';
import { LogBox } from 'react-native';
import { Provider } from 'react-redux';
import { store } from '../src/redux/store';
import { Slot } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

if (__DEV__) {
  LogBox.ignoreLogs(['Unable to activate keep awake']);
}

export default function RootLayout() {
  return (
    <Provider store={store}>
      <SafeAreaProvider>
        <Slot />
      </SafeAreaProvider>
    </Provider>
  );
}

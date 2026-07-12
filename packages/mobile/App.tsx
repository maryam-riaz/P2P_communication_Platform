import './src/utils/polyfills';
import React, { useEffect, useState } from 'react';
import { Provider, useSelector, useDispatch } from 'react-redux';
import { store } from './src/redux/store';
import { RootState } from './src/redux/store';
import { restoreLogin } from './src/redux/slices/authSlice';
import AuthStack from './src/navigation/AuthStack';
import AppStack from './src/navigation/AppStack';
import * as SecureStore from 'expo-secure-store';
import { StatusBar, View, ActivityIndicator, Text, StyleSheet } from 'react-native';
import { ServiceContext } from './src/context/ServiceContext';
import { useInitializeServices } from './src/hooks/useInitializeServices';

function AppContent() {
  const dispatch = useDispatch();
  const { isLoggedIn } = useSelector((state: RootState) => state.auth);
  const [isLoading, setIsLoading] = useState(true);

  // Bootstrap WatermelonDB + all service singletons (AuthService, ChatService, MapService, SosService)
  const services = useInitializeServices();

  useEffect(() => {
    // Try to restore login from secure storage
    const restoreAsync = async () => {
      try {
        const savedUser = await SecureStore.getItemAsync('user');
        const savedRole = await SecureStore.getItemAsync('role');
        if (savedUser && savedRole) {
          dispatch(restoreLogin({ name: savedUser, role: savedRole as 'user' | 'responder' | 'admin' }));
        }
      } catch (e) {
        console.error('Failed to restore login', e);
      } finally {
        setIsLoading(false);
      }
    };

    restoreAsync();
  }, [dispatch]);

  // Show loading spinner until both DB services AND login restoration are ready
  if (isLoading || !services) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#FF8C42" />
        <Text style={styles.loadingText}>
          {!services ? 'Opening secure database…' : 'Restoring session…'}
        </Text>
      </View>
    );
  }

  return (
    // Provide the real service instances to every screen via context
    <ServiceContext.Provider value={services}>
      {isLoggedIn ? <AppStack /> : <AuthStack />}
    </ServiceContext.Provider>
  );
}

export default function App() {
  return (
    <Provider store={store}>
      <AppContent />
      <StatusBar barStyle="light-content" />
    </Provider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    color: '#999',
    fontSize: 14,
  },
});

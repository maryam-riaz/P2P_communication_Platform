import React, { useState, useContext } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDispatch } from 'react-redux';
import { login } from '../../redux/slices/authSlice';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useService } from '../../hooks/useService';
import { AuthService } from '../../services/AuthService';
import { ServiceContext } from '../../context/ServiceContext';

export default function LoginScreen({ navigation }: any) {
  const [name, setName] = useState('');
  const dispatch = useDispatch();
  const authService = useService(AuthService);
  const services = useContext(ServiceContext);

  const handleLogin = async () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Please enter your name');
      return;
    }

    try {
      // Create local user profile, ECDH keys, and secure private key
      const localUser = await authService.login('user', name.trim());
      
      // Bootstrap discovery advertiser, scanner, and socket streams
      await services.initTransportsForUser(localUser);

      // Dispatch login to Redux to switch Navigation stacks
      dispatch(login({ name: name.trim(), role: 'user' }));
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to save login credentials');
    }
  };


  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      
      <TouchableOpacity
        style={styles.backButton}
        onPress={() => navigation.goBack()}
      >
        <MaterialCommunityIcons name="chevron-left" size={28} color="#FF8C42" />
      </TouchableOpacity>

      <View style={styles.header}>
        <MaterialCommunityIcons name="account-circle" size={64} color="#FF8C42" />
        <Text style={styles.title}>User Login</Text>
        <Text style={styles.subtitle}>Get emergency help and safety tools</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>ENTER NAME</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Muhammad Talha"
          placeholderTextColor="#666"
          value={name}
          onChangeText={setName}
          autoFocus
        />

        <TouchableOpacity style={styles.loginButton} onPress={handleLogin}>
          <Text style={styles.loginButtonText}>Get Started →</Text>
        </TouchableOpacity>

        <Text style={styles.disclaimer}>
          This is how other users will see you during emergency communications and alert sharing.
        </Text>
      </View>

      <Text style={styles.footer}>
        By continuing, you agree to our response protocols and privacy terms.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    paddingHorizontal: 20,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  header: {
    alignItems: 'center',
    marginTop: 40,
    marginBottom: 60,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginTop: 16,
  },
  subtitle: {
    fontSize: 14,
    color: '#999',
    marginTop: 8,
  },
  form: {
    flex: 1,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#999',
    letterSpacing: 1,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    padding: 14,
    color: '#FFFFFF',
    fontSize: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#333',
  },
  loginButton: {
    backgroundColor: '#FF8C42',
    borderRadius: 24,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  loginButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  disclaimer: {
    fontSize: 12,
    color: '#666',
    marginTop: 16,
    lineHeight: 18,
  },
  footer: {
    textAlign: 'center',
    color: '#666',
    fontSize: 11,
    marginBottom: 20,
    lineHeight: 16,
  },
});

import React, { useState, useContext } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  StatusBar,
  Alert,
} from 'react-native';
import { useDispatch } from 'react-redux';
import { login } from '../../redux/slices/authSlice';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useService } from '../../hooks/useService';
import { AuthService } from '../../services/AuthService';
import { ServiceContext } from '../../context/ServiceContext';

export default function AdminLoginScreen({ navigation }: any) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const dispatch = useDispatch();
  const authService = useService(AuthService);
  const services = useContext(ServiceContext);

  const handleLogin = async () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Please enter your username');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters');
      return;
    }

    try {
      // Create local user profile, ECDH keys, and secure private key
      const localUser = await authService.login('admin', name.trim());
      
      // Bootstrap discovery advertiser, scanner, and socket streams
      await services.initTransportsForUser(localUser);

      // Dispatch login to Redux to switch Navigation stacks
      dispatch(login({ name: name.trim(), role: 'admin' }));
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
        <MaterialCommunityIcons name="chevron-left" size={28} color="#028090" />
      </TouchableOpacity>

      <View style={styles.header}>
        <View style={styles.logoCircle}>
          <Text style={styles.logoText}>HEC</Text>
        </View>
        <Text style={styles.title}>Admin</Text>
        <Text style={styles.subtitle}>Sign in</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>ENTER NAME</Text>
        <TextInput
          style={styles.input}
          placeholder="Admin username"
          placeholderTextColor="#666"
          value={name}
          onChangeText={setName}
          autoFocus
        />

        <Text style={styles.label}>ENTER PASSWORD</Text>
        <View style={styles.passwordContainer}>
          <TextInput
            style={styles.passwordInput}
            placeholder="••••••••"
            placeholderTextColor="#666"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
          />
          <TouchableOpacity
            onPress={() => setShowPassword(!showPassword)}
            style={styles.eyeButton}
          >
            <MaterialCommunityIcons
              name={showPassword ? 'eye-off' : 'eye'}
              size={20}
              color="#666"
            />
          </TouchableOpacity>
        </View>

        <TouchableOpacity>
          <Text style={styles.forgotPassword}>forgot password?</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.loginButton} onPress={handleLogin}>
          <Text style={styles.loginButtonText}>Log in</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>
        © 2024 Sosify (Emergency Systems)
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
  logoCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: '#028090',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  logoText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#028090',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#999',
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
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#333',
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 12,
  },
  passwordInput: {
    flex: 1,
    padding: 14,
    color: '#FFFFFF',
    fontSize: 16,
  },
  eyeButton: {
    paddingRight: 12,
  },
  forgotPassword: {
    color: '#FF8C42',
    fontSize: 12,
    marginBottom: 24,
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
  footer: {
    textAlign: 'center',
    color: '#666',
    fontSize: 11,
    marginBottom: 20,
  },
});

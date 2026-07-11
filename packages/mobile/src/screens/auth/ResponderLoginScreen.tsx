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

export default function ResponderLoginScreen({ navigation }: any) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const dispatch = useDispatch();
  const authService = useService(AuthService);
  const services = useContext(ServiceContext);

  const handleLogin = async () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Please enter your name');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters');
      return;
    }

    try {
      // Create local user profile, ECDH keys, and secure private key
      const localUser = await authService.login('responder', name.trim());
      
      // Bootstrap discovery advertiser, scanner, and socket streams
      await services.initTransportsForUser(localUser);

      // Dispatch login to Redux to switch Navigation stacks
      dispatch(login({ name: name.trim(), role: 'responder' }));
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
        <MaterialCommunityIcons name="chevron-left" size={28} color="#E0005C" />
      </TouchableOpacity>

      <View style={styles.header}>
        <MaterialCommunityIcons name="hospital-box" size={64} color="#E0005C" />
        <Text style={styles.title}>Responder Login</Text>
        <Text style={styles.subtitle}>Manage and view emergency alerts</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>RESPONDER NAME</Text>
        <TextInput
          style={styles.input}
          placeholder="Rescuer Name"
          placeholderTextColor="#666"
          value={name}
          onChangeText={setName}
          autoFocus
        />

        <Text style={styles.label}>PASSWORD</Text>
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

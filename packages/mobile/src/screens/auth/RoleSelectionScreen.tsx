import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  // SafeAreaView,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context'; 
import { MaterialCommunityIcons } from '@expo/vector-icons';

export default function RoleSelectionScreen({ navigation }: any) {
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      
      <View style={styles.header}>
        <MaterialCommunityIcons name="alert-circle" size={48} color="#FF8C42" />
        <Text style={styles.title}>SOSIFY</Text>
        <Text style={styles.subtitle}>Emergency Communication App</Text>
      </View>

      <View style={styles.content}>
        <Text style={styles.questionText}>Who is using the app?</Text>

        <TouchableOpacity
          style={styles.roleButton}
          onPress={() => navigation.navigate('UserLogin')}
        >
          <View style={styles.roleIcon}>
            <MaterialCommunityIcons name="account-circle" size={40} color="#FF8C42" />
          </View>
          <View style={styles.roleTextContainer}>
            <Text style={styles.roleTitle}>User</Text>
            <Text style={styles.roleDescription}>Access emergency help and safety tools</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={24} color="#666" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.roleButton}
          onPress={() => navigation.navigate('ResponderLogin')}
        >
          <View style={styles.roleIcon}>
            <MaterialCommunityIcons name="hospital-box" size={40} color="#E0005C" />
          </View>
          <View style={styles.roleTextContainer}>
            <Text style={styles.roleTitle}>Responder</Text>
            <Text style={styles.roleDescription}>Manage and view emergency alerts</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={24} color="#666" />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.roleButton, styles.adminButton]}
          onPress={() => navigation.navigate('AdminLogin')}
        >
          <View style={styles.roleIcon}>
            <MaterialCommunityIcons name="shield" size={40} color="#028090" />
          </View>
          <View style={styles.roleTextContainer}>
            <Text style={styles.roleTitle}>Admin</Text>
            <Text style={styles.roleDescription}>System administration and settings</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={24} color="#666" />
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>
        Designed to save lives when infrastructure fails
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    paddingHorizontal: 16,
  },
  header: {
    alignItems: 'center',
    marginTop: 40,
    marginBottom: 60,
  },
  title: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginTop: 12,
  },
  subtitle: {
    fontSize: 14,
    color: '#999',
    marginTop: 4,
  },
  content: {
    flex: 1,
  },
  questionText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 24,
  },
  roleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#FF8C42',
  },
  adminButton: {
    borderLeftColor: '#028090',
  },
  roleIcon: {
    marginRight: 16,
  },
  roleTextContainer: {
    flex: 1,
  },
  roleTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  roleDescription: {
    fontSize: 12,
    color: '#999',
    marginTop: 4,
  },
  footer: {
    textAlign: 'center',
    color: '#666',
    fontSize: 12,
    marginBottom: 20,
  },
});

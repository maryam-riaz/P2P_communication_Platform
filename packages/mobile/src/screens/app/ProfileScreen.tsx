import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../redux/store';
import { logout } from '../../redux/slices/authSlice';
import { MaterialCommunityIcons } from '@expo/vector-icons';

export default function ProfileScreen({ navigation }: any) {
  const dispatch = useDispatch();
  const { user, role } = useSelector((state: RootState) => state.auth);

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        onPress: () => dispatch(logout()),
        style: 'destructive',
      },
    ]);
  };

  const getRoleColor = () => {
    switch (role) {
      case 'user': return '#FF8C42';
      case 'responder': return '#E0005C';
      case 'admin': return '#028090';
      default: return '#666';
    }
  };

  const getRoleIcon = () => {
    switch (role) {
      case 'user': return 'account-circle';
      case 'responder': return 'hospital-box';
      case 'admin': return 'shield-admin';
      default: return 'account';
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <SafeAreaView style={styles.headerWrapper}>
        <TouchableOpacity style={styles.headerContainer} onPress={() => navigation.navigate('Home')}>
          <Text style={styles.sosifyLogo}>* SOSIFY</Text>
        </TouchableOpacity>
      </SafeAreaView>
      <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={styles.profileCard}>
        <View style={[styles.avatar, { backgroundColor: `${getRoleColor()}20` }]}>
          <MaterialCommunityIcons name={getRoleIcon() as any} size={48} color={getRoleColor()} />
        </View>
        <Text style={styles.userName}>{user}</Text>
        <View style={styles.roleBadge}>
          <Text style={[styles.roleText, { color: getRoleColor() }]}>{role?.toUpperCase()}</Text>
        </View>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account Settings</Text>
        <TouchableOpacity style={styles.settingItem}>
          <View style={styles.settingLeft}>
            <MaterialCommunityIcons name="account-edit" size={20} color="#FF8C42" />
            <Text style={styles.settingText}>Edit Profile</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={20} color="#666" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.settingItem}>
          <View style={styles.settingLeft}>
            <MaterialCommunityIcons name="lock" size={20} color="#FF8C42" />
            <Text style={styles.settingText}>Change Password</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={20} color="#666" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.settingItem}>
          <View style={styles.settingLeft}>
            <MaterialCommunityIcons name="bell" size={20} color="#FF8C42" />
            <Text style={styles.settingText}>Notifications</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={20} color="#666" />
        </TouchableOpacity>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Support & Help</Text>
        <TouchableOpacity style={styles.settingItem}>
          <View style={styles.settingLeft}>
            <MaterialCommunityIcons name="help-circle" size={20} color="#FF8C42" />
            <Text style={styles.settingText}>Help & Support</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={20} color="#666" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.settingItem}>
          <View style={styles.settingLeft}>
            <MaterialCommunityIcons name="file-document" size={20} color="#FF8C42" />
            <Text style={styles.settingText}>Terms of Service</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={20} color="#666" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.settingItem}>
          <View style={styles.settingLeft}>
            <MaterialCommunityIcons name="shield-check" size={20} color="#FF8C42" />
            <Text style={styles.settingText}>Privacy Policy</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={20} color="#666" />
        </TouchableOpacity>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>App Info</Text>
        <View style={styles.infoItem}>
          <Text style={styles.infoLabel}>Version</Text>
          <Text style={styles.infoValue}>1.0.0</Text>
        </View>
        <View style={styles.infoItem}>
          <Text style={styles.infoLabel}>Build</Text>
          <Text style={styles.infoValue}>20240703</Text>
        </View>
      </View>
      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <MaterialCommunityIcons name="logout" size={20} color="#E0005C" />
        <Text style={styles.logoutButtonText}>Logout</Text>
      </TouchableOpacity>
      <Text style={styles.footer}>© 2024 Sosify Emergency Systems</Text>
      </ScrollView>
      <SafeAreaView style={styles.bottomSafeArea} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  headerWrapper: { backgroundColor: '#000000' },
  headerContainer: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1A1A1A' },
  sosifyLogo: { fontSize: 24, fontWeight: 'bold', color: '#FF8C42' },
  bottomSafeArea: { backgroundColor: '#000000' },
  profileCard: { alignItems: 'center', paddingVertical: 32, borderBottomWidth: 1, borderBottomColor: '#1A1A1A' },
  avatar: { width: 80, height: 80, borderRadius: 40, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  userName: { fontSize: 20, fontWeight: '600', color: '#FFF', marginBottom: 8 },
  roleBadge: { backgroundColor: '#1A1A1A', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: '#333' },
  roleText: { fontSize: 12, fontWeight: '600' },
  section: { paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#1A1A1A' },
  sectionTitle: { fontSize: 12, fontWeight: '600', color: '#999', paddingHorizontal: 16, paddingBottom: 12, letterSpacing: 0.5 },
  settingItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  settingLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingText: { fontSize: 15, color: '#FFF' },
  infoItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  infoLabel: { fontSize: 15, color: '#FFF' },
  infoValue: { fontSize: 14, color: '#999' },
  logoutButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginHorizontal: 16, marginVertical: 20, paddingVertical: 12, borderWidth: 1, borderColor: '#E0005C', borderRadius: 8 },
  logoutButtonText: { color: '#E0005C', fontSize: 15, fontWeight: '600' },
  footer: { textAlign: 'center', color: '#666', fontSize: 11, marginBottom: 12 },
});

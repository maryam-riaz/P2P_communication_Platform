import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { PAKISTAN_PROVINCES, PAKISTAN_CITIES } from './pakistanMapData';

const DEFAULT_LAT = 33.6844;
const DEFAULT_LNG = 73.0479;

const MOCK_PEERS = [
  { id: 'peer-001', name: 'Ahmed Raza', role: 'responder', lat: 33.6944, lng: 73.0579, distance: 50 },
  { id: 'peer-002', name: 'Fatima Bibi', role: 'user', lat: 33.6744, lng: 73.0379, distance: 120 },
];

const MOCK_SOS = [
  { id: 'sos-001', lat: 33.6544, lng: 73.0279, description: 'Fire reported near market area' },
];

export default function MapScreen({ navigation }: any) {
  const mapContainerRef = useRef<any>(null);
  const leafletMapRef = useRef<any>(null);
  const leafletMarkersRef = useRef<any[]>([]);
  const [peerCount] = useState(MOCK_PEERS.length);

  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);

      const map = (window as any).L.map('web-map', {
        zoomControl: false,
        attributionControl: false,
      }).setView([DEFAULT_LAT, DEFAULT_LNG], 5);

      (window as any).L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 24,
      }).addTo(map);

      leafletMapRef.current = map;

      const myIcon = (window as any).L.divIcon({
        className: 'leaflet-custom-marker',
        html: '<div style="width:10px;height:10px;border-radius:50%;background:#00D4FF;border:2px solid #FFF;"></div>',
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      });
      (window as any).L.marker([DEFAULT_LAT, DEFAULT_LNG], { icon: myIcon }).addTo(map).bindPopup('<b>Me (You)</b>');

      MOCK_PEERS.forEach((peer) => {
        const col = peer.role === 'responder' || peer.role === 'admin' ? '#FF4081' : '#FF8C42';
        const pi = (window as any).L.divIcon({
          className: 'leaflet-custom-marker',
          html: `<div style="width:10px;height:10px;border-radius:50%;background:${col};border:2px solid #FFF;"></div>`,
          iconSize: [10, 10],
          iconAnchor: [5, 5],
        });
        const m = (window as any).L.marker([peer.lat, peer.lng], { icon: pi }).addTo(map);
        m.bindPopup(`<b>${peer.name}</b><br/>${peer.distance.toFixed(1)}m`);
        leafletMarkersRef.current.push(m);
      });

      MOCK_SOS.forEach((s) => {
        const si = (window as any).L.divIcon({
          className: 'leaflet-custom-marker',
          html: '<div style="width:14px;height:14px;background:#FF3B30;border:2px solid #FFF;transform:rotate(45deg);"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        });
        (window as any).L.marker([s.lat, s.lng], { icon: si }).addTo(map)
          .bindPopup(`<b style="color:#FF3B30;">SOS!</b><br/>${s.description}`);
      });
    };
    document.head.appendChild(script);
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <SafeAreaView style={styles.headerWrapper}>
        <View style={styles.headerContainer}>
          <TouchableOpacity onPress={() => navigation.reset({ index: 0, routes: [{ name: 'Home' }] })}>
            <Text style={styles.sosifyLogo}>* SOSIFY</Text>
          </TouchableOpacity>
          <Text style={styles.gpsStatusText}>GPS Active</Text>
        </View>
      </SafeAreaView>
      <View ref={mapContainerRef} id="web-map" style={styles.mapContainer} />
      <View style={styles.connectionBadge}>
        <Text style={styles.connectionText}>Connected ({peerCount} peers)</Text>
      </View>
      <SafeAreaView style={styles.bottomWrapper}>
        <View style={styles.statsContainer}>
          <View style={styles.statBox}>
            <Text style={styles.statUsersNumber}>1</Text>
            <Text style={styles.statLabel}>Discovered Users</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.statBox}>
            <Text style={styles.statRescuersNumber}>1</Text>
            <Text style={styles.statLabel}>Discovered Rescuers</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.messageButton} onPress={() => navigation.navigate('ChatList')}>
          <MaterialCommunityIcons name="message-text" size={20} color="#FFF" />
          <Text style={styles.messageButtonText}>Messages</Text>
        </TouchableOpacity>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  headerWrapper: { backgroundColor: '#000000' },
  headerContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1A1A1A' },
  sosifyLogo: { fontSize: 24, fontWeight: 'bold', color: '#FF8C42' },
  gpsStatusText: { fontSize: 11, fontWeight: '700', color: '#888' },
  mapContainer: { flex: 1, backgroundColor: '#111111' },
  bottomWrapper: { backgroundColor: '#000000' },
  connectionBadge: { position: 'absolute', top: 130, right: 16, backgroundColor: 'rgba(26, 26, 26, 0.95)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#333', zIndex: 10 },
  connectionText: { color: '#FF8C42', fontSize: 12, fontWeight: '600' },
  statsContainer: { flexDirection: 'row', backgroundColor: '#1A1A1A', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#333' },
  statBox: { flex: 1, alignItems: 'center' },
  divider: { width: 1, backgroundColor: '#333', marginHorizontal: 8 },
  statUsersNumber: { fontSize: 20, fontWeight: '700', color: '#FF8C42' },
  statLabel: { fontSize: 11, color: '#999', marginTop: 2 },
  statRescuersNumber: { fontSize: 20, fontWeight: '700', color: '#FF4081' },
  messageButton: { flexDirection: 'row', backgroundColor: '#FF8C42', marginHorizontal: 16, marginBottom: 16, marginTop: 8, paddingVertical: 12, borderRadius: 8, justifyContent: 'center', alignItems: 'center', gap: 8 },
  messageButtonText: { color: '#FFF', fontWeight: '600', fontSize: 14 },
});

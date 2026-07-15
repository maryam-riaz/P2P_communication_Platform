import React, { useEffect, useState, useContext, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../redux/store';
import { setUserLocation, setNearbyUsers, setNearbyRescuers } from '../../redux/slices/mapSlice';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useService } from '../../hooks/useService';
import { MapService, PeerPin } from '../../services/MapService';
import { SosService } from '../../services/SosService';
import { ServiceContext } from '../../context/ServiceContext';
import { MobileRepository } from '../../db/repository';

const DEFAULT_LAT = 37.7749;
const DEFAULT_LNG = -122.4194;

function rssiToDistance(rssi: number): number {
  const A = -59;
  const n = 2.5;
  if (rssi >= 0) return 0.1;
  return Math.pow(10, (A - rssi) / (10 * n));
}

function getStableAngleForPeer(deviceId: string): number {
  let hash = 0;
  for (let i = 0; i < deviceId.length; i++) {
    hash = deviceId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash % 360) * (Math.PI / 180);
}

export default function MapScreen({ navigation }: any) {
  const dispatch = useDispatch();
  const { userLocation, nearbyUsers, nearbyRescuers } = useSelector(
    (state: RootState) => state.map
  );
  
  const mapService = useService(MapService);
  const sosService = useService(SosService);
  const services = useContext(ServiceContext);
  
  const [rawPeers, setRawPeers] = useState<PeerPin[]>([]);
  const [sosPins, setSosPins] = useState<any[]>([]);
  const [peerCount, setPeerCount] = useState(0);

  // Leaflet initialization states and refs
  const [leafletLoaded, setLeafletLoaded] = useState(false);
  const mapContainerRef = useRef<any>(null);
  const leafletMapRef = useRef<any>(null);
  const leafletMarkersRef = useRef<any[]>([]);

  // Simulate a discovered peer locally in the sandbox
  const handleSimulatePeer = async () => {
    if (services && services.database) {
      const peersRepo = new MobileRepository(services.database);
      const isResponder = Math.random() > 0.5;
      const role = isResponder ? 'responder' : 'user';
      const mockDeviceId = isResponder
        ? `Resc_${Math.floor(Math.random() * 1000)}`
        : `Vict_${Math.floor(Math.random() * 1000)}`;

      await peersRepo.addNewPeer({
        deviceId: mockDeviceId,
        publicKey: 'mock-public-key-hash',
        role,
        trustStatus: 'trusted'
      });

      // Update RSSI randomly between -40 (very close) and -90 (far)
      const mockRssi = -40 - Math.floor(Math.random() * 50);
      mapService.updatePeerRssi(mockDeviceId, mockRssi);

      const baseLat = userLocation?.latitude || DEFAULT_LAT;
      const baseLng = userLocation?.longitude || DEFAULT_LNG;
      const offsetLat = (Math.random() - 0.5) * 0.005;
      const offsetLng = (Math.random() - 0.5) * 0.005;

      await peersRepo.updatePeerLocation(
        mockDeviceId,
        baseLat + offsetLat,
        baseLng + offsetLng
      );
    }
  };

  // Load Leaflet JS & CSS dynamically from CDN
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }

    if ((window as any).L) {
      setLeafletLoaded(true);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.onload = () => {
      setLeafletLoaded(true);
    };
    document.head.appendChild(script);
  }, []);

  // Set up service subscriptions
  useEffect(() => {
    // 1. Start location tracking on Web
    const startTracking = async () => {
      try {
        await mapService.startLocationTracking();
      } catch (err: any) {
        console.warn('[MapScreen Web] Location access required or skipped.');
      }
    };
    startTracking();

    // 2. Subscribe to location changes
    const myLocationSub = mapService.observeMyLocation().subscribe((coords) => {
      dispatch(
        setUserLocation({
          latitude: coords.latitude,
          longitude: coords.longitude,
        })
      );
    });

    // 3. Subscribe to discovered peers on the Map
    const peerSub = mapService.observePeerLocations().subscribe((peers) => {
      setRawPeers(peers);
      setPeerCount(peers.length);
      
      const hasOwnGps = userLocation && userLocation.latitude && userLocation.longitude;
      const baseLat = hasOwnGps ? userLocation.latitude : DEFAULT_LAT;
      const baseLng = hasOwnGps ? userLocation.longitude : DEFAULT_LNG;

      const victims = peers.filter(p => p.role === 'user').map(p => {
        let lat = p.lat;
        let lng = p.lng;
        if (lat === null || lng === null) {
          const d = rssiToDistance(p.rssi);
          const angle = getStableAngleForPeer(p.deviceId);
          lat = baseLat + (d / 111111) * Math.sin(angle);
          lng = baseLng + (d / (111111 * Math.cos(baseLat * (Math.PI / 180)))) * Math.cos(angle);
        }
        return {
          id: p.deviceId,
          name: p.displayName,
          location: { latitude: lat, longitude: lng },
          distance: rssiToDistance(p.rssi),
        };
      });

      const responders = peers.filter(p => p.role === 'responder' || p.role === 'admin').map(p => {
        let lat = p.lat;
        let lng = p.lng;
        if (lat === null || lng === null) {
          const d = rssiToDistance(p.rssi);
          const angle = getStableAngleForPeer(p.deviceId);
          lat = baseLat + (d / 111111) * Math.sin(angle);
          lng = baseLng + (d / (111111 * Math.cos(baseLat * (Math.PI / 180)))) * Math.cos(angle);
        }
        return {
          id: p.deviceId,
          name: p.displayName,
          location: { latitude: lat, longitude: lng },
          distance: rssiToDistance(p.rssi),
        };
      });

      dispatch(setNearbyUsers(victims as any));
      dispatch(setNearbyRescuers(responders as any));
    });

    // 4. Subscribe to active open SOS incidents
    const sosSub = sosService.observeOpenSosEvents().subscribe((events) => {
      setSosPins(events);
    });

    return () => {
      mapService.stopLocationTracking();
      myLocationSub.unsubscribe();
      peerSub.unsubscribe();
      sosSub.unsubscribe();
    };
  }, [mapService, sosService, userLocation, dispatch]);

  // Solve location states
  const hasOwnGps = userLocation && userLocation.latitude && userLocation.longitude;
  let baseLat = hasOwnGps ? userLocation.latitude : null;
  let baseLng = hasOwnGps ? userLocation.longitude : null;

  if (!hasOwnGps) {
    let sumLat = 0;
    let sumLng = 0;
    let sumWeights = 0;

    rawPeers.forEach((p) => {
      if (p.lat !== null && p.lng !== null) {
        const d = rssiToDistance(p.rssi);
        const weight = 1 / (d * d || 0.1);
        sumLat += p.lat * weight;
        sumLng += p.lng * weight;
        sumWeights += weight;
      }
    });

    if (sumWeights > 0) {
      baseLat = sumLat / sumWeights;
      baseLng = sumLng / sumWeights;
    } else {
      baseLat = DEFAULT_LAT;
      baseLng = DEFAULT_LNG;
    }
  }

  const seenIds = new Set<string>();
  const resolvedPeers = rawPeers
    .filter((p) => {
      if (seenIds.has(p.deviceId)) return false;
      seenIds.add(p.deviceId);
      return true;
    })
    .map((p) => {
      let peerLat = p.lat;
      let peerLng = p.lng;

      if (peerLat === null || peerLng === null) {
        const d = rssiToDistance(p.rssi);
        const angle = getStableAngleForPeer(p.deviceId);
        const latOffset = (d / 111111) * Math.sin(angle);
        const lngOffset = (d / (111111 * Math.cos(baseLat! * (Math.PI / 180)))) * Math.cos(angle);
        peerLat = baseLat! + latOffset;
        peerLng = baseLng! + lngOffset;
      }

      return {
        id: p.deviceId,
        name: p.displayName,
        role: p.role,
        rssi: p.rssi,
        distance: rssiToDistance(p.rssi),
        location: { latitude: peerLat, longitude: peerLng },
      };
    });

  // Render Leaflet map & markers
  useEffect(() => {
    if (!leafletLoaded || !mapContainerRef.current) return;

    const L = (window as any).L;
    if (!L) return;

    if (!leafletMapRef.current) {
      leafletMapRef.current = L.map(mapContainerRef.current, {
        zoomControl: false,
        attributionControl: false,
      }).setView([baseLat, baseLng], 14);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 20,
      }).addTo(leafletMapRef.current);

      L.control.zoom({
        position: 'bottomright'
      }).addTo(leafletMapRef.current);
    } else {
      leafletMapRef.current.setView([baseLat, baseLng]);
    }

    const map = leafletMapRef.current;

    // Clear old markers
    leafletMarkersRef.current.forEach((marker) => marker.remove());
    leafletMarkersRef.current = [];

    // 1. Me (User) marker -> Blue/Cyan
    const meHtml = `
      <div style="position: relative; width: 30px; height: 30px; display: flex; justify-content: center; align-items: center;">
        <div style="position: absolute; width: 22px; height: 22px; border-radius: 50%; border: 2px solid #00D4FF; background-color: rgba(0, 212, 255, 0.2); animation: leaflet-pulse 2s infinite;"></div>
        <div style="width: 10px; height: 10px; border-radius: 50%; background-color: #00D4FF; border: 2px solid #FFF; box-shadow: 0 0 6px #00D4FF; z-index: 10;"></div>
      </div>
    `;
    const meIcon = L.divIcon({
      className: 'leaflet-custom-me-marker',
      html: meHtml,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    const meMarker = L.marker([baseLat, baseLng], { icon: meIcon })
      .addTo(map)
      .bindPopup('<b>Me (You)</b><br/>Blue/Cyan Pin');
    leafletMarkersRef.current.push(meMarker);

    // 2. Discovered Peer markers -> Rescuers Pink, Victims Orange
    resolvedPeers.forEach((peer) => {
      const isResponder = peer.role === 'responder' || peer.role === 'admin';
      const color = isResponder ? '#FF4081' : '#FF8C42';
      const roleName = isResponder ? 'Rescuer' : 'Victim';

      const peerHtml = `
        <div style="position: relative; width: 30px; height: 30px; display: flex; justify-content: center; align-items: center;">
          <div style="position: absolute; width: 22px; height: 22px; border-radius: 50%; border: 2px solid ${color}; background-color: ${color}33; animation: leaflet-pulse 2.5s infinite;"></div>
          <div style="width: 10px; height: 10px; border-radius: 50%; background-color: ${color}; border: 2px solid #FFF; box-shadow: 0 0 6px ${color}; z-index: 10;"></div>
        </div>
      `;
      const peerIcon = L.divIcon({
        className: 'leaflet-custom-peer-marker',
        html: peerHtml,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });

      const marker = L.marker([peer.location.latitude, peer.location.longitude], { icon: peerIcon })
        .addTo(map)
        .bindPopup(`
          <div style="color: #000; font-family: sans-serif; font-size: 13px; line-height: 1.4;">
            <b>${peer.name}</b><br/>
            Role: ${roleName}<br/>
            Distance: ${peer.distance.toFixed(1)}m<br/>
            Signal (RSSI): ${peer.rssi} dBm<br/>
            <button onclick="window.leafletChatNavigate('${peer.id}', '${peer.name}')" style="margin-top: 8px; width: 100%; padding: 6px; background-color: #FF8C42; border: none; color: #FFF; border-radius: 4px; cursor: pointer; font-weight: bold;">Chat</button>
          </div>
        `);
      leafletMarkersRef.current.push(marker);

      // Signal accuracy circle
      const circle = L.circle([peer.location.latitude, peer.location.longitude], {
        color: color,
        fillColor: color,
        fillOpacity: 0.08,
        weight: 1,
        radius: peer.distance,
      }).addTo(map);
      leafletMarkersRef.current.push(circle);
    });

    // 3. SOS Incident Markers
    sosPins.forEach((sos) => {
      const coords = [sos.lat, sos.lng];
      const sosHtml = `
        <div style="position: relative; width: 30px; height: 30px; display: flex; justify-content: center; align-items: center;">
          <div style="position: absolute; width: 26px; height: 26px; border-radius: 50%; border: 2px solid #FF3B30; background-color: rgba(255, 59, 48, 0.2); animation: leaflet-pulse 1.5s infinite;"></div>
          <div style="width: 10px; height: 10px; background-color: #FF3B30; border: 2px solid #FFF; transform: rotate(45deg); box-shadow: 0 0 6px #FF3B30; z-index: 10;"></div>
        </div>
      `;
      const sosIcon = L.divIcon({
        className: 'leaflet-custom-sos-marker',
        html: sosHtml,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });

      const description = (sos._raw as any).description || 'Emergency assistance requested';
      const marker = L.marker(coords, { icon: sosIcon })
        .addTo(map)
        .bindPopup(`
          <div style="color: #000; font-family: sans-serif; font-size: 13px;">
            <b style="color: #FF3B30;">🚨 SOS ALERT!</b><br/>
            ${description}
          </div>
        `);
      leafletMarkersRef.current.push(marker);
    });

    (window as any).leafletChatNavigate = (peerId: string, peerName: string) => {
      handleMarkerPress({ id: peerId, name: peerName });
    };

  }, [leafletLoaded, baseLat, baseLng, resolvedPeers, sosPins]);

  const handleMarkerPress = (person: any) => {
    navigation.navigate('Chat', { recipientId: person.id, recipientName: person.name });
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      <SafeAreaView style={styles.headerWrapper}>
        <View style={styles.headerContainer}>
          <TouchableOpacity onPress={() => navigation.reset({ index: 0, routes: [{ name: 'Home' }] })}>
            <Text style={styles.sosifyLogo}>* SOSIFY</Text>
          </TouchableOpacity>
          <Text style={styles.gpsStatusText}>
            {hasOwnGps ? '🟢 GPS Active' : '🟡 Offline Grid (RSSI Solved)'}
          </Text>
        </View>
      </SafeAreaView>

      {/* Interactive Map View */}
      <View style={styles.mapContainer}>
        {Platform.OS === 'web' && (
          <style dangerouslySetInnerHTML={{ __html: `
            @keyframes leaflet-pulse {
              0% { transform: scale(0.8); opacity: 0.9; }
              100% { transform: scale(2.4); opacity: 0; }
            }
            .leaflet-custom-marker, .leaflet-custom-me-marker, .leaflet-custom-peer-marker, .leaflet-custom-sos-marker {
              background: none !important;
              border: none !important;
            }
          `}} />
        )}
        <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
      </View>

      {/* Floating Connection Indicator */}
      <View style={styles.connectionBadge}>
        <Text style={styles.connectionText}>
          📡 {peerCount > 0 ? `Connected (${peerCount} peers)` : 'Searching...'}
        </Text>
      </View>

      {/* Simulation Trigger button for Web Development sandbox */}
      <TouchableOpacity
        style={styles.simulateButton}
        onPress={handleSimulatePeer}
      >
        <Text style={styles.simulateButtonText}>➕ Simulate Discovered Peer</Text>
      </TouchableOpacity>

      <SafeAreaView style={styles.bottomWrapper}>
        <View style={styles.statsContainer}>
          <View style={styles.statBox}>
            <Text style={styles.statUsersNumber}>{nearbyUsers.length}</Text>
            <Text style={styles.statLabel}>Nearby Users</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.statBox}>
            <Text style={styles.statRescuersNumber}>{nearbyRescuers.length}</Text>
            <Text style={styles.statLabel}>Nearby Rescuers</Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.messageButton}
          onPress={() => navigation.navigate('ChatList')}
        >
          <MaterialCommunityIcons name="message-text" size={20} color="#FFF" />
          <Text style={styles.messageButtonText}>Messages</Text>
        </TouchableOpacity>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  headerWrapper: {
    backgroundColor: '#000000',
  },
  headerContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  sosifyLogo: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FF8C42',
  },
  gpsStatusText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
  },
  mapContainer: {
    flex: 1,
    backgroundColor: '#111111',
  },
  bottomWrapper: {
    backgroundColor: '#000000',
  },
  connectionBadge: {
    position: 'absolute',
    top: 75,
    right: 16,
    backgroundColor: 'rgba(26, 26, 26, 0.95)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#333',
    zIndex: 1000,
  },
  connectionText: {
    color: '#FF8C42',
    fontSize: 12,
    fontWeight: '600',
  },
  simulateButton: {
    position: 'absolute',
    top: 125,
    right: 16,
    backgroundColor: '#00D4FF',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
    zIndex: 1000,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  simulateButtonText: {
    color: '#000',
    fontSize: 12,
    fontWeight: 'bold',
  },
  statsContainer: {
    flexDirection: 'row',
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
  },
  divider: {
    width: 1,
    backgroundColor: '#333',
    marginHorizontal: 8,
  },
  statUsersNumber: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FF8C42',
  },
  statLabel: {
    fontSize: 11,
    color: '#999',
    marginTop: 2,
  },
  statRescuersNumber: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FF4081',
  },
  messageButton: {
    flexDirection: 'row',
    backgroundColor: '#FF8C42',
    marginHorizontal: 16,
    marginBottom: 16,
    marginTop: 8,
    paddingVertical: 12,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  messageButtonText: {
    color: '#FFF',
    fontWeight: '600',
    fontSize: 14,
  },
});

import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  TouchableOpacity,
  Platform,
  Animated,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSelector, useDispatch } from 'react-redux';
import MapView, { Marker, Circle, PROVIDER_DEFAULT } from 'react-native-maps';
import { RootState } from '../../redux/store';
import { setUserLocation, setNearbyUsers, setNearbyRescuers } from '../../redux/slices/mapSlice';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useService } from '../../hooks/useService';
import { MapService, PeerPin } from '../../services/MapService';
import { SosService } from '../../services/SosService';

// Default map coordinate fallback (e.g. San Francisco disaster simulation center)
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

// ─── Pulsing Sonar Ripple Component ──────────────────────────────────────────
const SonarPulse = ({ color }: { color: string }) => {
  const scaleValue = useRef(new Animated.Value(1)).current;
  const opacityValue = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    Animated.loop(
      Animated.parallel([
        Animated.timing(scaleValue, {
          toValue: 4,
          duration: 2500,
          useNativeDriver: true,
        }),
        Animated.timing(opacityValue, {
          toValue: 0,
          duration: 2500,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [scaleValue, opacityValue]);

  return (
    <Animated.View
      style={[
        styles.pulseCircle,
        {
          transform: [{ scale: scaleValue }],
          opacity: opacityValue,
          borderColor: color,
          backgroundColor: color + '33', // 20% opacity hex
        },
      ]}
    />
  );
};

export default function MapScreen({ navigation }: any) {
  const dispatch = useDispatch();
  const mapRef = useRef<MapView>(null);

  const { userLocation, nearbyUsers, nearbyRescuers } = useSelector(
    (state: RootState) => state.map
  );
  
  const mapService = useService(MapService);
  const sosService = useService(SosService);
  
  const [rawPeers, setRawPeers] = useState<PeerPin[]>([]);
  const [sosPins, setSosPins] = useState<any[]>([]);
  const [peerCount, setPeerCount] = useState(0);

  // Derived relative locations state
  const [mySolvedCoords, setMySolvedCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [solvedPeers, setSolvedPeers] = useState<any[]>([]);
  const [isMapReady, setIsMapReady] = useState(false);
  const [wifiEnabled, setWifiEnabled] = useState(true);
  const [gpsEnabled, setGpsEnabled] = useState(true);

  // Check system services state (Wi-Fi and Location)
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    let isMounted = true;

    const checkGps = async () => {
      try {
        const enabled = await Location.hasServicesEnabledAsync();
        if (isMounted) setGpsEnabled(enabled);
      } catch (e) {
        // Fallback
      }
    };

    // Check GPS immediately and periodically
    checkGps();
    const interval = setInterval(checkGps, 3000);

    // Subscribe to Wi-Fi Direct state changes
    let unsubState = () => {};
    try {
      const { AndroidWifiP2PTransport } = require('../../comms/wifi-direct/wifi-p2p-transport.android');
      unsubState = AndroidWifiP2PTransport.onStateChanged((enabled: boolean) => {
        if (isMounted) setWifiEnabled(enabled);
      });
    } catch (e) {
      console.warn('[MapScreen] Failed to load P2P state listener:', e);
    }

    return () => {
      isMounted = false;
      clearInterval(interval);
      unsubState();
    };
  }, []);

  useEffect(() => {
    // 1. Start location tracking
    const startTracking = async () => {
      try {
        await mapService.startLocationTracking();
      } catch (err: any) {
        console.warn('[MapScreen] Location access restricted, relying on relative mapping.');
      }
    };
    startTracking();

    // 2. Subscribe to own coordinates
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
    });

    // 4. Subscribe to active SOS alerts
    const sosSub = sosService.observeOpenSosEvents().subscribe((events) => {
      setSosPins(events);
    });

    return () => {
      mapService.stopLocationTracking();
      myLocationSub.unsubscribe();
      peerSub.unsubscribe();
      sosSub.unsubscribe();
    };
  }, [mapService, sosService]);

  // ─── Solve Localization Layout ───────────────────────────────────────────────
  useEffect(() => {
    // Step A: Determine if local GPS coordinates are valid
    const hasOwnGps = userLocation && userLocation.latitude && userLocation.longitude;
    let baseLat = hasOwnGps ? userLocation.latitude : null;
    let baseLng = hasOwnGps ? userLocation.longitude : null;

    // Step B: If local GPS is offline, attempt weighted centroid of peers with coordinates
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
        // Absolute fallback to mock origin
        baseLat = DEFAULT_LAT;
        baseLng = DEFAULT_LNG;
      }
      setMySolvedCoords({ latitude: baseLat, longitude: baseLng });
    } else {
      setMySolvedCoords({ latitude: baseLat!, longitude: baseLng! });
    }

    // Step C: Position all peers on the layout
    const seenIds = new Set<string>();
    const resolved = rawPeers
      .filter((p) => {
        if (seenIds.has(p.deviceId)) return false;
        seenIds.add(p.deviceId);
        return true;
      })
      .map((p) => {
        let peerLat = p.lat;
        let peerLng = p.lng;

        // If peer has no coordinates, offset them relative to our base location using RSSI distance
        if (peerLat === null || peerLng === null) {
          const d = rssiToDistance(p.rssi);
          const angle = getStableAngleForPeer(p.deviceId);
          
          // 111111 meters roughly equal to 1 degree of coordinate offset
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
          isRelativeOnly: p.lat === null || p.lng === null,
        };
      });

    setSolvedPeers(resolved);

    // Sync state slices for redux consumers
    const victims = resolved.filter(p => p.role === 'user');
    const responders = resolved.filter(p => p.role === 'responder' || p.role === 'admin');
    dispatch(setNearbyUsers(victims as any));
    dispatch(setNearbyRescuers(responders as any));

  }, [userLocation, rawPeers, dispatch]);

  const hasCenteredRef = useRef(false);

  const handleCenterMap = useCallback(() => {
    if (!mySolvedCoords || !mapRef.current || !isMapReady) return;
    
    const coordsToFit = [{ latitude: mySolvedCoords.latitude, longitude: mySolvedCoords.longitude }];
    solvedPeers.forEach((p) => {
      if (p.location && p.location.latitude && p.location.longitude) {
        coordsToFit.push(p.location);
      }
    });

    if (coordsToFit.length > 1) {
      mapRef.current.fitToCoordinates(coordsToFit, {
        edgePadding: { top: 120, right: 120, bottom: 120, left: 120 },
        animated: true,
      });
    } else {
      mapRef.current.animateToRegion({
        latitude: mySolvedCoords.latitude,
        longitude: mySolvedCoords.longitude,
        latitudeDelta: 0.015,
        longitudeDelta: 0.015,
      }, 1000);
    }
  }, [mySolvedCoords, solvedPeers, isMapReady]);

  // Center map on local solved coordinates and fit to show all peers (ONLY on first load)
  useEffect(() => {
    if (mySolvedCoords && isMapReady && !hasCenteredRef.current) {
      handleCenterMap();
      hasCenteredRef.current = true;
    }
  }, [mySolvedCoords, isMapReady, handleCenterMap]);

  const handleMarkerPress = (person: any) => {
    navigation.navigate('Chat', { recipientId: person.id, recipientName: person.name });
  };

  const hasOwnGps = userLocation && userLocation.latitude && userLocation.longitude;

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

      {/* Warning Banner for Disabled Services */}
      {Platform.OS === 'android' && (!wifiEnabled || !gpsEnabled) && (
        <View style={styles.warningBanner}>
          <MaterialCommunityIcons name="alert-circle" size={18} color="#FFF" style={{ marginRight: 8 }} />
          <Text style={styles.warningText}>
            {!wifiEnabled && !gpsEnabled
              ? 'Warning: Wi-Fi and Location/GPS are turned off. Please enable them in your quick settings panel to communicate with nearby peers.'
              : !wifiEnabled
              ? 'Warning: Wi-Fi is turned off. Please enable it in your quick settings panel to search and connect to nearby peers.'
              : 'Warning: Location Services/GPS is turned off. Please enable it in your settings to discover nearby peers.'}
          </Text>
        </View>
      )}

      {/* Main Interactive Map View */}
      {mySolvedCoords && (
        <MapView
          ref={mapRef}
          style={styles.map}
          provider={PROVIDER_DEFAULT}
          customMapStyle={darkMapStyle}
          onMapReady={() => setIsMapReady(true)}
          initialRegion={{
            latitude: mySolvedCoords.latitude,
            longitude: mySolvedCoords.longitude,
            latitudeDelta: 0.015,
            longitudeDelta: 0.015,
          }}
        >
          {/* 1. Self Marker */}
          <Marker coordinate={mySolvedCoords} title="Me" zIndex={10}>
            <View style={styles.markerContainer}>
              <View style={[styles.pulseCircle, { borderColor: '#02C39A', backgroundColor: '#02C39A33', transform: [{ scale: 1.5 }] }]} />
              <View style={[styles.markerDot, { backgroundColor: '#02C39A' }]} />
            </View>
          </Marker>

          {/* 2. Discovered Peer Markers */}
          {solvedPeers.map((peer) => {
            const isResponder = peer.role === 'responder' || peer.role === 'admin';
            const color = isResponder ? '#E0005C' : '#FF8C42';
            return (
              <React.Fragment key={peer.id}>
                {/* Draw signal distance range circle around peers */}
                <Circle
                  center={peer.location}
                  radius={peer.distance}
                  fillColor={color + '1A'}
                  strokeColor={color + '4D'}
                  strokeWidth={1}
                />
                <Marker
                  coordinate={peer.location}
                  title={peer.name}
                  description={`${isResponder ? 'Rescuer' : 'Victim'} • Est. Dist: ${peer.distance.toFixed(1)}m`}
                  onCalloutPress={() => handleMarkerPress(peer)}
                  zIndex={5}
                >
                  <View style={styles.markerContainer}>
                    <View style={[styles.pulseCircle, { borderColor: color, backgroundColor: color + '33', transform: [{ scale: 1.5 }] }]} />
                    <View style={[styles.markerDot, { backgroundColor: color }]} />
                  </View>
                </Marker>
              </React.Fragment>
            );
          })}

          {/* 3. SOS Incident Markers */}
          {sosPins.map((sos) => {
            const coords = { latitude: sos.lat, longitude: sos.lng };
            return (
              <Marker
                key={sos.id}
                coordinate={coords}
                title="🚨 SOS ALERT!"
                description={(sos._raw as any).description || 'Emergency assistance requested'}
                zIndex={8}
              >
                <View style={styles.markerContainer}>
                  <SonarPulse color="#FF3B30" />
                  <View style={[styles.markerDot, { backgroundColor: '#FF3B30', borderRadius: 0, transform: [{ rotate: '45deg' }] }]} />
                </View>
              </Marker>
            );
          })}
        </MapView>
      )}

      {/* Floating Connection Indicator */}
      <View style={styles.connectionBadge}>
        <Text style={styles.connectionText}>
          📡 {peerCount > 0 ? `Connected (${peerCount} peers)` : 'Searching...'}
        </Text>
      </View>

      {/* Floating Center Map Button */}
      {mySolvedCoords && (
        <TouchableOpacity
          style={styles.centerMapButton}
          onPress={handleCenterMap}
          activeOpacity={0.8}
        >
          <MaterialCommunityIcons name="crosshairs-gps" size={22} color="#FFF" />
        </TouchableOpacity>
      )}

      <SafeAreaView style={styles.bottomWrapper}>
        <View style={styles.statsContainer}>
          <View style={styles.statBox}>
            <Text style={styles.statUsersNumber}>{nearbyUsers.length}</Text>
            <Text style={styles.statLabel}>Discovered Users</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.statBox}>
            <Text style={styles.statRescuersNumber}>{nearbyRescuers.length}</Text>
            <Text style={styles.statLabel}>Discovered Rescuers</Text>
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

// Curated Sleek Dark Map design configuration for MapView
const darkMapStyle = [
  { "elementType": "geometry", "stylers": [{ "color": "#1A1A1A" }] },
  { "elementType": "labels.text.fill", "stylers": [{ "color": "#757575" }] },
  { "elementType": "labels.text.stroke", "stylers": [{ "color": "#1A1A1A" }] },
  { "featureType": "administrative", "elementType": "geometry", "stylers": [{ "color": "#333333" }] },
  { "featureType": "landscape", "elementType": "geometry", "stylers": [{ "color": "#1F1F1F" }] },
  { "featureType": "poi", "elementType": "geometry", "stylers": [{ "color": "#1E1E1E" }] },
  { "featureType": "road", "elementType": "geometry.fill", "stylers": [{ "color": "#2C2C2C" }] },
  { "featureType": "road", "elementType": "geometry.stroke", "stylers": [{ "color": "#1A1A1A" }] },
  { "featureType": "water", "elementType": "geometry", "stylers": [{ "color": "#0F0F0F" }] }
];

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  warningBanner: {
    backgroundColor: '#D9383A',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    zIndex: 20,
  },
  warningText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
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
  map: {
    flex: 1,
  },
  bottomWrapper: {
    backgroundColor: '#000000',
  },
  markerContainer: {
    width: 60,
    height: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pulseCircle: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
  },
  markerDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#FFF',
    zIndex: 2,
  },
  connectionBadge: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 120 : 130,
    right: 16,
    backgroundColor: 'rgba(26, 26, 26, 0.95)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#333',
    zIndex: 10,
  },
  connectionText: {
    color: '#FF8C42',
    fontSize: 12,
    fontWeight: '600',
  },
  centerMapButton: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 170 : 180,
    right: 16,
    backgroundColor: '#FF8C42',
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 6,
    zIndex: 10,
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
    color: '#E0005C',
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

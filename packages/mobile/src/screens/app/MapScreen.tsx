import React, { useEffect, useState } from 'react';
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
import { MapService } from '../../services/MapService';
import { SosService } from '../../services/SosService';

export default function MapScreen({ navigation }: any) {
  const dispatch = useDispatch();
  const { userLocation, nearbyUsers, nearbyRescuers } = useSelector(
    (state: RootState) => state.map
  );
  
  const mapService = useService(MapService);
  const sosService = useService(SosService);
  
  const [sosPins, setSosPins] = useState<any[]>([]);
  const [peerCount, setPeerCount] = useState(0);

  useEffect(() => {
    // 1. Start location tracking
    const startTracking = async () => {
      try {
        await mapService.startLocationTracking();
      } catch (err: any) {
        console.warn('[MapScreen] Location access required or skipped.');
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

    // 3. Subscribe to discovered peers
    const peerSub = mapService.observePeerLocations().subscribe((peers) => {
      setPeerCount(peers.length);
      
      const victims = peers.filter(p => p.role === 'user').map(p => ({
        id: p.deviceId,
        name: p.displayName,
        location: { latitude: p.lat || 0, longitude: p.lng || 0 }
      }));

      const responders = peers.filter(p => p.role === 'responder' || p.role === 'admin').map(p => ({
        id: p.deviceId,
        name: p.displayName,
        location: { latitude: p.lat || 0, longitude: p.lng || 0 }
      }));

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
  }, [mapService, sosService]);

  const handleMarkerPress = (person: any) => {
    navigation.navigate('Chat', { recipientId: person.id, recipientName: person.name });
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      <SafeAreaView style={styles.headerWrapper}>
        <TouchableOpacity style={styles.headerContainer} onPress={() => navigation.reset({index: 0, routes: [{name: 'Home'}]})}>
          <Text style={styles.sosifyLogo}>* SOSIFY</Text>
        </TouchableOpacity>
      </SafeAreaView>

      {/* Interactive Grid Map / Peer List Representation */}
      <View style={styles.mapPlaceholder}>
        <MaterialCommunityIcons name="map-marker-radius" size={48} color="#FF8C42" />
        <Text style={styles.placeholderTitle}>Interactive Map Interface</Text>
        <Text style={styles.placeholderSubtitle}>
          {userLocation 
            ? `Your Coordinates: ${userLocation.latitude.toFixed(4)}, ${userLocation.longitude.toFixed(4)}`
            : "Locating user..."}
        </Text>
        
        {/* Render list of detected nodes */}
        <View style={styles.nodeListContainer}>
          <Text style={styles.nodeListHeader}>Discovered Mesh Nodes:</Text>
          {nearbyUsers.map(u => (
            <TouchableOpacity key={u.id} style={styles.nodeItem} onPress={() => handleMarkerPress(u)}>
              <Text style={styles.nodeItemText}>👤 {u.name} (Peer Victim)</Text>
            </TouchableOpacity>
          ))}
          {nearbyRescuers.map(r => (
            <TouchableOpacity key={r.id} style={styles.nodeItem} onPress={() => handleMarkerPress(r)}>
              <Text style={styles.nodeItemTextResponder}>🛡️ {r.name} (Rescuer)</Text>
            </TouchableOpacity>
          ))}
          {sosPins.map(sos => (
            <View key={sos.id} style={styles.nodeItemSos}>
              <Text style={styles.nodeItemTextSos}>🚨 SOS Alert: {(sos._raw as any).description || 'Urgent assistance required'}</Text>
            </View>
          ))}
          {nearbyUsers.length === 0 && nearbyRescuers.length === 0 && sosPins.length === 0 && (
            <Text style={styles.placeholderSubtitle}>No mesh node locations broadcasted yet.</Text>
          )}
        </View>
      </View>

      {/* Floating Connection Indicator */}
      <View style={styles.connectionBadge}>
        <Text style={styles.connectionText}>
          📡 {peerCount > 0 ? `Connected (${peerCount} peers)` : 'Searching...'}
        </Text>
      </View>

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
  bottomWrapper: {
    backgroundColor: '#000000',
  },
  mapPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111111',
    borderWidth: 1,
    borderColor: '#222',
    margin: 16,
    borderRadius: 12,
    padding: 16,
  },
  placeholderTitle: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 12,
  },
  placeholderSubtitle: {
    color: '#666',
    fontSize: 13,
    marginTop: 4,
    textAlign: 'center',
  },
  nodeListContainer: {
    marginTop: 24,
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    padding: 12,
  },
  nodeListHeader: {
    color: '#888',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 8,
    textAlign: 'center',
  },
  nodeItem: {
    backgroundColor: '#262626',
    padding: 10,
    borderRadius: 6,
    marginVertical: 4,
  },
  nodeItemText: {
    color: '#FF8C42',
    fontSize: 13,
    fontWeight: '600',
  },
  nodeItemTextResponder: {
    color: '#E0005C',
    fontSize: 13,
    fontWeight: '600',
  },
  nodeItemSos: {
    backgroundColor: '#3b1c1c',
    borderColor: '#FF3B30',
    borderWidth: 1,
    padding: 10,
    borderRadius: 6,
    marginVertical: 4,
  },
  nodeItemTextSos: {
    color: '#FF3B30',
    fontSize: 12,
    fontWeight: '600',
  },
  connectionBadge: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 70,
    right: 16,
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  connectionText: {
    color: '#FF8C42',
    fontSize: 12,
    fontWeight: '600',
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

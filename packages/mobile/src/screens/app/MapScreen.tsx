import React, { useEffect, useState, useRef, useCallback } from 'react';
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
import * as Location from 'expo-location';
import { BleManager } from 'react-native-ble-plx';
import { useService } from '../../hooks/useService';
import { MapService, PeerPin } from '../../services/MapService';
import { SosService } from '../../services/SosService';
import { WebView } from 'react-native-webview';
import { LEAFLET_CSS, LEAFLET_JS } from './leafletAssets';
import { PAKISTAN_PROVINCES, PAKISTAN_CITIES } from './pakistanMapData';



// Build Leaflet HTML using string concatenation (NOT template literals)
// to avoid backtick/interpolation issues with minified Leaflet source
function buildLeafletHtml(defaultLat: number, defaultLng: number, provincesJson: string, citiesJson: string): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />',
    '<style>' + LEAFLET_CSS + '</style>',
    '<script>' + LEAFLET_JS + '<\/script>',
    '<style>',
    'html, body {',
    '  margin: 0; padding: 0;',
    '  height: 100vh; width: 100vw;',
    '  overflow: hidden;',
    '  background-color: #111111;',
    '}',
    '#map {',
    '  position: absolute; top: 0; left: 0;',
    '  width: 100vw; height: 100vh;',
    '  background-color: #111111;',
    '}',
    '@keyframes leaflet-pulse {',
    '  0% { transform: scale(0.8); opacity: 0.9; }',
    '  100% { transform: scale(2.4); opacity: 0; }',
    '}',
    '.leaflet-custom-marker { background: none !important; border: none !important; }',
    '<\/style>',
    '<\/head>',
    '<body>',
    '<div id="map"></div>',
    '<script>',
    // Console/error bridge
    'window.onerror = function(msg, src, line, col, err) {',
    '  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "error", message: String(msg), source: src, lineno: line, colno: col })); } catch(e) {}',
    '  return true;',
    '};',
    'var _olog = console.log;',
    'console.log = function() { try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "log", message: Array.prototype.slice.call(arguments).join(" ") })); } catch(e) {} _olog.apply(console, arguments); };',
    'var _oerr = console.error;',
    'console.error = function() { try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "error_log", message: Array.prototype.slice.call(arguments).join(" ") })); } catch(e) {} _oerr.apply(console, arguments); };',
    // Map state
    'var map = null;',
    'var markers = [];',
    'var mapReady = false;',
    'var boundsFitted = false;',
    // initMap
    'function initMap(lat, lng) {',
    '  if (mapReady) { try { map.setView([lat, lng]); } catch(e) {} return; }',
    '  try {',
    '    map = L.map("map", { zoomControl: false, attributionControl: false, maxZoom: 24 }).setView([lat, lng], 5);',
    '    var darkPixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScAAAAAElFTkSuQmCC";',
    '    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 24, maxNativeZoom: 20, errorTileUrl: darkPixel }).addTo(map);',
    '    L.control.zoom({ position: "bottomright" }).addTo(map);',
    '    mapReady = true;',
    '    console.log("[Map] Initialized at " + lat + "," + lng);',
    // Draw Pakistan province outlines
    '    try {',
    '      var provinces = ' + provincesJson + ';',
    '      provinces.forEach(function(prov) {',
    '        L.polygon(prov.coordinates, {',
    '          color: prov.color,',
    '          weight: 1.5,',
    '          fillColor: prov.color,',
    '          fillOpacity: 0.04',
    '        }).addTo(map).bindTooltip(prov.name, { permanent: false, direction: "center" });',
    '      });',
    '    } catch(err) { console.error("[Map] Province rendering failed: " + err.message); }',
    // Draw Pakistan major cities
    '    try {',
    '      var cities = ' + citiesJson + ';',
    '      cities.forEach(function(city) {',
    '        var cityIcon = L.divIcon({',
    '          className: "leaflet-custom-marker",',
    '          html: "<div style=\'display:flex;flex-direction:column;align-items:center;justify-content:center;\'><div style=\'width:5px;height:5px;border-radius:50%;background-color:#444;border:1px solid #777;\'></div><div style=\'font-size:9px;color:#888;margin-top:1px;white-space:nowrap;font-family:sans-serif;text-shadow:0 0 2px #000;pointer-events:none;\'>" + city.name + "</div></div>",',
    '          iconSize: [80, 25],',
    '          iconAnchor: [40, 3]',
    '        });',
    '        L.marker([city.lat, city.lng], { icon: cityIcon }).addTo(map)',
    '          .bindPopup("<b>" + city.name + "</b><br/>" + city.description);',
    '      });',
    '    } catch(err) { console.error("[Map] City rendering failed: " + err.message); }',
    '  } catch(e) { console.error("[Map] initMap failed: " + e.message); }',
    '}',
    // updateMap
    'function updateMap(baseLat, baseLng, peersJson, sosJson) {',
    '  initMap(baseLat, baseLng);',
    '  if (!mapReady) { console.error("[Map] not ready, skipping update"); return; }',
    '  markers.forEach(function(m) { try { m.remove(); } catch(e) {} });',
    '  markers = [];',
    '  var meHtml = "<div style=\'position:relative;width:30px;height:30px;display:flex;justify-content:center;align-items:center;\'><div style=\'position:absolute;width:22px;height:22px;border-radius:50%;border:2px solid #00D4FF;background-color:rgba(0,212,255,0.2);animation:leaflet-pulse 2s infinite;\'></div><div style=\'width:10px;height:10px;border-radius:50%;background-color:#00D4FF;border:2px solid #FFF;box-shadow:0 0 6px #00D4FF;z-index:10;\'></div></div>";',
    '  var meIcon = L.divIcon({ className: "leaflet-custom-marker", html: meHtml, iconSize: [30,30], iconAnchor: [15,15] });',
    '  markers.push(L.marker([baseLat, baseLng], { icon: meIcon }).addTo(map).bindPopup("<b>Me (You)</b>"));',
    '  try {',
    '    var peers = JSON.parse(peersJson);',
    '    peers.forEach(function(peer) {',
    '      var isRes = peer.role === "responder" || peer.role === "admin";',
    '      var col = isRes ? "#FF4081" : "#FF8C42";',
    '      var nm = isRes ? "Rescuer" : "Victim";',
    '      var ph = "<div style=\'position:relative;width:30px;height:30px;display:flex;justify-content:center;align-items:center;\'><div style=\'position:absolute;width:22px;height:22px;border-radius:50%;border:2px solid " + col + ";background-color:" + col + "33;animation:leaflet-pulse 2.5s infinite;\'></div><div style=\'width:10px;height:10px;border-radius:50%;background-color:" + col + ";border:2px solid #FFF;box-shadow:0 0 6px " + col + ";z-index:10;\'></div></div>";',
    '      var pi = L.divIcon({ className: "leaflet-custom-marker", html: ph, iconSize: [30,30], iconAnchor: [15,15] });',
    '      var pm = L.marker([peer.lat, peer.lng], { icon: pi }).addTo(map);',
    '      pm.bindPopup("<b>" + peer.name + "</b><br/>" + nm + "<br/>" + peer.distance.toFixed(1) + "m");',
    '      markers.push(pm);',
    '      markers.push(L.circle([peer.lat, peer.lng], { color: col, fillColor: col, fillOpacity: 0.08, weight: 1, radius: peer.distance }).addTo(map));',
    '    });',
    '  } catch(e) { console.error("[Map] peers parse error: " + e.message); }',
    '  try {',
    '    var sos = JSON.parse(sosJson);',
    '    sos.forEach(function(s) {',
    '      var sh = "<div style=\'position:relative;width:30px;height:30px;display:flex;justify-content:center;align-items:center;\'><div style=\'position:absolute;width:26px;height:26px;border-radius:50%;border:2px solid #FF3B30;background-color:rgba(255,59,48,0.2);animation:leaflet-pulse 1.5s infinite;\'></div><div style=\'width:10px;height:10px;background-color:#FF3B30;border:2px solid #FFF;transform:rotate(45deg);box-shadow:0 0 6px #FF3B30;z-index:10;\'></div></div>";',
    '      var si = L.divIcon({ className: "leaflet-custom-marker", html: sh, iconSize: [30,30], iconAnchor: [15,15] });',
    '      markers.push(L.marker([s.lat, s.lng], { icon: si }).addTo(map).bindPopup("<b style=\'color:#FF3B30;\'>SOS!</b><br/>" + (s.description || "Emergency")));',
    '    });',
    '  } catch(e) { console.error("[Map] sos parse error: " + e.message); }',
    '  if (!boundsFitted) {',
    '    centerOnUsers();',
    '    boundsFitted = true;',
    '  }',
    '}',
    // centerOnUsers function
    'function centerOnUsers() {',
    '  if (!map || !mapReady) return;',
    '  var boundsPoints = [];',
    '  markers.forEach(function(m) {',
    '    if (m && typeof m.getLatLng === "function") {',
    '      boundsPoints.push(m.getLatLng());',
    '    }',
    '  });',
    '  if (boundsPoints.length > 0) {',
    '    if (boundsPoints.length > 1) {',
    '      map.fitBounds(boundsPoints, { padding: [50, 50], maxZoom: 16 });',
    '    } else {',
    '      map.setView(boundsPoints[0], 14);',
    '    }',
    '  }',
    '}',
    // Auto-init on load
    'document.addEventListener("DOMContentLoaded", function() {',
    '  initMap(' + defaultLat + ', ' + defaultLng + ');',
    '});',
    '<\/script>',
    '<\/body>',
    '<\/html>',
  ].join('\n');
}

// Default map coordinate fallback (Islamabad, Pakistan)
const DEFAULT_LAT = 33.6844;
const DEFAULT_LNG = 73.0479;

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

// Build the full HTML once — safely using array join, no template literals
const LEAFLET_HTML = buildLeafletHtml(
  DEFAULT_LAT,
  DEFAULT_LNG,
  JSON.stringify(PAKISTAN_PROVINCES),
  JSON.stringify(PAKISTAN_CITIES)
);


export default function MapScreen({ navigation }: any) {
  const dispatch = useDispatch();
  const webViewRef = useRef<WebView>(null);

  const { userLocation, nearbyUsers, nearbyRescuers } = useSelector(
    (state: RootState) => state.map
  );

  const mapService = useService(MapService);
  const sosService = useService(SosService);

  const [rawPeers, setRawPeers] = useState<PeerPin[]>([]);
  const [sosPins, setSosPins] = useState<any[]>([]);
  const [peerCount, setPeerCount] = useState(0);

  // Derived relative locations state
  const [mySolvedCoords, setMySolvedCoords] = useState<{ latitude: number; longitude: number }>({
    latitude: DEFAULT_LAT,
    longitude: DEFAULT_LNG,
  });
  const [solvedPeers, setSolvedPeers] = useState<any[]>([]);
  const [wifiEnabled, setWifiEnabled] = useState(true);
  const [gpsEnabled, setGpsEnabled] = useState(true);
  const [bluetoothEnabled, setBluetoothEnabled] = useState(true);

  // Check system services state (Wi-Fi and Location)
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    let isMounted = true;

    const bleManager = new BleManager();
    const checkGps = async () => {
      try {
        const enabled = await Location.hasServicesEnabledAsync();
        if (isMounted) setGpsEnabled(enabled);
      } catch (e) {
        // Fallback
      }
    };

    const checkBluetooth = async () => {
      try {
        const state = await bleManager.state();
        if (isMounted) setBluetoothEnabled(state === 'PoweredOn');
      } catch (e) {
        // Fallback
      }
    };

    // Check GPS and Bluetooth immediately and periodically
    checkGps();
    checkBluetooth();
    const interval = setInterval(() => {
      checkGps();
      checkBluetooth();
    }, 3000);

    // Subscribe to Wi-Fi Direct state changes
    let unsubState = () => { };
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
      bleManager.destroy();
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
  }, [mapService, sosService, dispatch]);

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

  // Inject coordinate updates to WebView Leaflet Map
  const handleUpdateWebView = useCallback(() => {
    if (!webViewRef.current) return;

    const peersData = JSON.stringify(
      solvedPeers.map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        rssi: p.rssi,
        distance: p.distance,
        lat: p.location.latitude,
        lng: p.location.longitude,
      }))
    );

    const sosData = JSON.stringify(
      sosPins.map(s => ({
        id: s.id,
        lat: s.lat,
        lng: s.lng,
        description: (s._raw as any).description,
      }))
    );

    const jsCode = `updateMap(${mySolvedCoords.latitude}, ${mySolvedCoords.longitude}, '${peersData}', '${sosData}');`;
    webViewRef.current.injectJavaScript(jsCode);
  }, [mySolvedCoords, solvedPeers, sosPins]);

  // Push updates to Leaflet on state changes
  useEffect(() => {
    handleUpdateWebView();
  }, [mySolvedCoords, solvedPeers, sosPins, handleUpdateWebView]);

  const handleCenterMap = () => {
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript('centerOnUsers();');
    }
  };

  const handleWebViewMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'chat') {
        navigation.navigate('Chat', { recipientId: data.id, recipientName: data.name });
      } else if (data.type === 'error') {
        console.warn('[WebView JavaScript Error]', data.message, 'at', data.source, 'line', data.lineno);
      } else if (data.type === 'log') {
        console.log('[WebView Console Log]', data.message);
      } else if (data.type === 'error_log') {
        console.warn('[WebView Console Error]', data.message);
      }
    } catch (e) {
      console.warn('[MapScreen] Failed to handle WebView message:', e);
    }
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
      {Platform.OS === 'android' && (!wifiEnabled || !gpsEnabled || !bluetoothEnabled) && (
        <View style={styles.warningBanner}>
          <MaterialCommunityIcons name="alert-circle" size={18} color="#FFF" style={{ marginRight: 8 }} />
          <Text style={styles.warningText}>
            {!wifiEnabled && !gpsEnabled && !bluetoothEnabled
              ? 'Warning: Wi-Fi, Bluetooth and Location/GPS are turned off. Please enable them to communicate with nearby devices.'
              : !wifiEnabled
                ? 'Warning: Wi-Fi is turned off.Please enable it to communicate with nearby devices'
                : !bluetoothEnabled
                  ? 'Warning: Bluetooth is turned off.Please enable it to detect nearby devices'
                  : 'Warning: Location Services/GPS is turned off.Please enable it to locate nearby devices'}
          </Text>
        </View>
      )}

      {/* WebView Leaflet Map rendering */}
      <View style={styles.mapContainer}>
        <WebView
          ref={webViewRef}
          source={{ html: LEAFLET_HTML, baseUrl: 'about:blank' }}
          style={styles.map}
          onMessage={handleWebViewMessage}
          onLoadEnd={handleUpdateWebView}
          originWhitelist={['*']}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          mixedContentMode="always"
          allowUniversalAccessFromFileURLs={true}
          allowFileAccessFromFileURLs={true}
          allowFileAccess={true}
        />
      </View>

      {/* Floating Connection Indicator */}
      <View style={styles.connectionBadge}>
        <Text style={styles.connectionText}>
          📡 {peerCount > 0 ? `Connected (${peerCount} peers)` : 'Searching...'}
        </Text>
      </View>

      {/* Floating Center Map Button */}
      <TouchableOpacity
        style={styles.centerMapButton}
        onPress={handleCenterMap}
        activeOpacity={0.8}
      >
        <MaterialCommunityIcons name="crosshairs-gps" size={22} color="#FFF" />
      </TouchableOpacity>

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
  mapContainer: {
    flex: 1,
    backgroundColor: '#111111',
  },
  map: {
    width: '100%',
    height: '100%',
    backgroundColor: '#111111',
  },
  bottomWrapper: {
    backgroundColor: '#000000',
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

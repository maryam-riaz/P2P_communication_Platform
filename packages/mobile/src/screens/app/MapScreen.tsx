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
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { LEAFLET_CSS, LEAFLET_JS } from './leafletAssets';
import { PAKISTAN_PROVINCES, PAKISTAN_CITIES } from './pakistanMapData';

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
    'window.onerror = function(msg, src, line, col, err) {',
    '  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "error", message: String(msg), source: src, lineno: line, colno: col })); } catch(e) {}',
    '  return true;',
    '};',
    'var _olog = console.log;',
    'console.log = function() { try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "log", message: Array.prototype.slice.call(arguments).join(" ") })); } catch(e) {} _olog.apply(console, arguments); };',
    'var _oerr = console.error;',
    'console.error = function() { try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "error_log", message: Array.prototype.slice.call(arguments).join(" ") })); } catch(e) {} _oerr.apply(console, arguments); };',
    'var map = null;',
    'var markers = [];',
    'var mapReady = false;',
    'var boundsFitted = false;',
    'function initMap(lat, lng) {',
    '  if (mapReady) { try { map.setView([lat, lng]); } catch(e) {} return; }',
    '  try {',
    '    map = L.map("map", { zoomControl: false, attributionControl: false, maxZoom: 24 }).setView([lat, lng], 5);',
    '    var darkPixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScAAAAAElFTkSuQmCC";',
    '    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 24, maxNativeZoom: 20, errorTileUrl: darkPixel }).addTo(map);',
    '    L.control.zoom({ position: "bottomright" }).addTo(map);',
    '    mapReady = true;',
    '    console.log("[Map] Initialized at " + lat + "," + lng);',
    '    try {',
    '      var provinces = ' + provincesJson + ';',
    '      provinces.forEach(function(prov) {',
    '        L.polygon(prov.coordinates, {',
    '          color: prov.color, weight: 1.5, fillColor: prov.color, fillOpacity: 0.04',
    '        }).addTo(map).bindTooltip(prov.name, { permanent: false, direction: "center" });',
    '      });',
    '    } catch(err) { console.error("[Map] Province rendering failed: " + err.message); }',
    '    try {',
    '      var cities = ' + citiesJson + ';',
    '      cities.forEach(function(city) {',
    '        var cityIcon = L.divIcon({',
    '          className: "leaflet-custom-marker",',
    '          html: "<div style=\'display:flex;flex-direction:column;align-items:center;justify-content:center;\'><div style=\'width:5px;height:5px;border-radius:50%;background-color:#444;border:1px solid #777;\'></div><div style=\'font-size:9px;color:#888;margin-top:1px;white-space:nowrap;font-family:sans-serif;text-shadow:0 0 2px #000;pointer-events:none;\'>" + city.name + "</div></div>",',
    '          iconSize: [80, 25], iconAnchor: [40, 3]',
    '        });',
    '        L.marker([city.lat, city.lng], { icon: cityIcon }).addTo(map)',
    '          .bindPopup("<b>" + city.name + "</b><br/>" + city.description);',
    '      });',
    '    } catch(err) { console.error("[Map] City rendering failed: " + err.message); }',
    '  } catch(e) { console.error("[Map] initMap failed: " + e.message); }',
    '}',
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
    '  if (!boundsFitted) { centerOnUsers(); boundsFitted = true; }',
    '}',
    'function centerOnUsers() {',
    '  if (!map || !mapReady) return;',
    '  var boundsPoints = [];',
    '  markers.forEach(function(m) {',
    '    if (m && typeof m.getLatLng === "function") { boundsPoints.push(m.getLatLng()); }',
    '  });',
    '  if (boundsPoints.length > 0) {',
    '    if (boundsPoints.length > 1) { map.fitBounds(boundsPoints, { padding: [50, 50], maxZoom: 16 }); }',
    '    else { map.setView(boundsPoints[0], 14); }',
    '  }',
    '}',
    'document.addEventListener("DOMContentLoaded", function() { initMap(' + defaultLat + ', ' + defaultLng + '); });',
    '<\/script>',
    '<\/body>',
    '<\/html>',
  ].join('\n');
}

const DEFAULT_LAT = 33.6844;
const DEFAULT_LNG = 73.0479;

const LEAFLET_HTML = buildLeafletHtml(
  DEFAULT_LAT, DEFAULT_LNG,
  JSON.stringify(PAKISTAN_PROVINCES),
  JSON.stringify(PAKISTAN_CITIES)
);

const MOCK_PEERS = [
  { id: 'peer-001', name: 'Ahmed Raza', role: 'responder', lat: 33.6944, lng: 73.0579, distance: 50 },
  { id: 'peer-002', name: 'Fatima Bibi', role: 'user', lat: 33.6744, lng: 73.0379, distance: 120 },
  { id: 'peer-003', name: 'Zain Ali', role: 'responder', lat: 33.6644, lng: 73.0679, distance: 80 },
];

const MOCK_SOS = [
  { id: 'sos-001', lat: 33.6544, lng: 73.0279, description: 'Fire reported near market area' },
];

export default function MapScreen({ navigation }: any) {
  const webViewRef = useRef<WebView>(null);
  const [peerCount] = useState(MOCK_PEERS.length);

  const handleUpdateWebView = useCallback(() => {
    if (!webViewRef.current) return;
    const peersData = JSON.stringify(MOCK_PEERS.map(p => ({ id: p.id, name: p.name, role: p.role, distance: p.distance, lat: p.lat, lng: p.lng, rssi: -60 })));
    const sosData = JSON.stringify(MOCK_SOS.map(s => ({ id: s.id, lat: s.lat, lng: s.lng, description: s.description })));
    const jsCode = `updateMap(${DEFAULT_LAT}, ${DEFAULT_LNG}, '${peersData}', '${sosData}');`;
    webViewRef.current.injectJavaScript(jsCode);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => handleUpdateWebView(), 500);
    return () => clearTimeout(timer);
  }, [handleUpdateWebView]);

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
      }
    } catch (e) {
      // ignore
    }
  };

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
      <View style={styles.connectionBadge}>
        <Text style={styles.connectionText}>
          Connected ({peerCount} peers)
        </Text>
      </View>
      <TouchableOpacity style={styles.centerMapButton} onPress={handleCenterMap} activeOpacity={0.8}>
        <MaterialCommunityIcons name="crosshairs-gps" size={22} color="#FFF" />
      </TouchableOpacity>
      <SafeAreaView style={styles.bottomWrapper}>
        <View style={styles.statsContainer}>
          <View style={styles.statBox}>
            <Text style={styles.statUsersNumber}>1</Text>
            <Text style={styles.statLabel}>Discovered Users</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.statBox}>
            <Text style={styles.statRescuersNumber}>2</Text>
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
  map: { width: '100%', height: '100%', backgroundColor: '#111111' },
  bottomWrapper: { backgroundColor: '#000000' },
  connectionBadge: { position: 'absolute', top: Platform.OS === 'ios' ? 120 : 130, right: 16, backgroundColor: 'rgba(26, 26, 26, 0.95)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#333', zIndex: 10 },
  connectionText: { color: '#FF8C42', fontSize: 12, fontWeight: '600' },
  centerMapButton: { position: 'absolute', bottom: Platform.OS === 'ios' ? 170 : 180, right: 16, backgroundColor: '#FF8C42', width: 46, height: 46, borderRadius: 23, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 6, zIndex: 10 },
  statsContainer: { flexDirection: 'row', backgroundColor: '#1A1A1A', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#333' },
  statBox: { flex: 1, alignItems: 'center' },
  divider: { width: 1, backgroundColor: '#333', marginHorizontal: 8 },
  statUsersNumber: { fontSize: 20, fontWeight: '700', color: '#FF8C42' },
  statLabel: { fontSize: 11, color: '#999', marginTop: 2 },
  statRescuersNumber: { fontSize: 20, fontWeight: '700', color: '#FF4081' },
  messageButton: { flexDirection: 'row', backgroundColor: '#FF8C42', marginHorizontal: 16, marginBottom: 16, marginTop: 8, paddingVertical: 12, borderRadius: 8, justifyContent: 'center', alignItems: 'center', gap: 8 },
  messageButtonText: { color: '#FFF', fontWeight: '600', fontSize: 14 },
});

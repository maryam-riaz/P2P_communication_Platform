import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  FlatList,
  Alert,
} from 'react-native';
import { meshTransport } from '../../nearby/MeshTransport';
import { PeerState } from '../../nearby/types';
import type { PayloadProgressEvent, PeerInfo } from '../../nearby/types';
import { logm, errm } from '../../utils/logger';

const SCREEN = 'SCREEN';
const HELLO_WORLD = btoa('hello world from Nearby Connections!');

type LogEntry = { timestamp: string; message: string };

function stateColor(state: PeerState): string {
  switch (state) {
    case PeerState.Found: return '#888';
    case PeerState.Connecting: return '#FFA500';
    case PeerState.Connected: return '#0F0';
    case PeerState.Disconnecting: return '#FF8C42';
    case PeerState.Disconnected: return '#E0005C';
    case PeerState.Reconnecting: return '#FFA500';
  }
}

function stateLabel(state: PeerState): string {
  switch (state) {
    case PeerState.Found: return 'FOUND';
    case PeerState.Connecting: return 'CONNECTING';
    case PeerState.Connected: return 'CONNECTED';
    case PeerState.Disconnecting: return 'DISCONNECTING';
    case PeerState.Disconnected: return 'DISCONNECTED';
    case PeerState.Reconnecting: return 'RECONNECTING';
  }
}

export default function NearbySpikeScreen() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [progress, setProgress] = useState<PayloadProgressEvent | null>(null);
  const logRef = useRef<ScrollView>(null);

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { timestamp, message }]);
    setTimeout(() => logRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  const showError = useCallback((title: string, message: string) => {
    errm(SCREEN, title, message);
    addLog(`!! ${title}: ${message}`);
    Alert.alert(title, message);
  }, [addLog]);

  const updatePeers = useCallback(() => {
    setPeers(meshTransport.getAllPeers());
  }, []);

  useEffect(() => {
    logm(SCREEN, '=== NearbySpikeScreen mounted ===');
    addLog('Phase 1 — Mesh Transport Module');
    addLog(`Platform: ${Platform.OS} ${Platform.Version}`);

    const unsubFound = meshTransport.onPeerFound((e) => {
      addLog(`FOUND: ${e.displayName} (${e.peerId})`);
      updatePeers();
    });

    const unsubLost = meshTransport.onPeerLost((e) => {
      addLog(`LOST: ${e.peerId}`);
      setPeers((prev) => prev.filter((p) => p.endpointId !== e.peerId));
    });

    const unsubConnected = meshTransport.onPeerConnected((e) => {
      addLog(`CONNECTED: ${e.peerId}`);
      updatePeers();
    });

    const unsubDisconnected = meshTransport.onPeerDisconnected((e) => {
      addLog(`DISCONNECTED: ${e.peerId}${e.unexpected ? ' (unexpected)' : ''}`);
      updatePeers();
    });

    const unsubData = meshTransport.onPayloadReceived((e) => {
      const decoded = atob(e.data);
      addLog(`PAYLOAD from ${e.peerId}: "${decoded}"`);
    });

    const unsubProgress = meshTransport.onPayloadProgress((e) => {
      setProgress(e);
      if (e.status === 'success' || e.status === 'failure') {
        setTimeout(() => setProgress(null), 2000);
      }
    });

    const unsubReconnecting = meshTransport.onReconnecting((e) => {
      addLog(`RECONNECTING to ${e.peerId} (${e.attempt}/${e.maxAttempts})`);
      updatePeers();
    });

    return () => {
      logm(SCREEN, '=== NearbySpikeScreen unmounting ===');
      unsubFound();
      unsubLost();
      unsubConnected();
      unsubDisconnected();
      unsubData();
      unsubProgress();
      unsubReconnecting();
      meshTransport.stopAll();
    };
  }, [addLog, updatePeers]);

  const handleAdvertise = async () => {
    try {
      logm(SCREEN, '=== ADVERTISE button pressed ===');
      addLog('Starting advertising...');
      await meshTransport.advertise();
      setIsAdvertising(true);
      addLog('Advertising started');
    } catch (e: any) {
      showError('Advertise Failed', e?.message || String(e));
    }
  };

  const handleDiscover = async () => {
    try {
      logm(SCREEN, '=== DISCOVER button pressed ===');
      addLog('Starting discovery...');
      await meshTransport.discover();
      setIsDiscovering(true);
      addLog('Discovery started');
    } catch (e: any) {
      showError('Discover Failed', e?.message || String(e));
    }
  };

  const handleConnect = async (endpointId: string) => {
    try {
      addLog(`Connecting to ${endpointId}...`);
      await meshTransport.connect(endpointId);
      addLog(`Connected to ${endpointId}`);
      updatePeers();
    } catch (e: any) {
      showError('Connect Failed', e?.message || String(e));
      updatePeers();
    }
  };

  const handleDisconnect = async (endpointId: string) => {
    try {
      addLog(`Disconnecting from ${endpointId}...`);
      await meshTransport.disconnect(endpointId);
      addLog(`Disconnected from ${endpointId}`);
      updatePeers();
    } catch (e: any) {
      showError('Disconnect Failed', e?.message || String(e));
    }
  };

  const handleSendHello = async () => {
    try {
      await meshTransport.broadcast(HELLO_WORLD);
      addLog('Broadcast "hello world" sent');
    } catch (e: any) {
      showError('Send Failed', e?.message || String(e));
    }
  };

  const handleStopAll = async () => {
    try {
      await meshTransport.stopAll();
      setIsAdvertising(false);
      setIsDiscovering(false);
      setPeers([]);
      addLog('All transport stopped');
    } catch (e: any) {
      showError('Stop Failed', e?.message || String(e));
    }
  };

  const renderPeer = ({ item }: { item: PeerInfo }) => (
    <View style={styles.peerRow}>
      <View style={styles.peerInfo}>
        <Text style={styles.peerName} numberOfLines={1}>
          {item.displayName || item.endpointId}
        </Text>
        <Text style={[styles.peerState, { color: stateColor(item.state) }]}>
          {stateLabel(item.state)}
        </Text>
      </View>
      <View style={styles.peerActions}>
        {item.state === PeerState.Found && (
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => handleConnect(item.endpointId)}
          >
            <Text style={styles.actionText}>CONNECT</Text>
          </TouchableOpacity>
        )}
        {(item.state === PeerState.Connected || item.state === PeerState.Reconnecting) && (
          <TouchableOpacity
            style={[styles.actionButton, styles.disconnectButton]}
            onPress={() => handleDisconnect(item.endpointId)}
          >
            <Text style={styles.actionText}>DISCONNECT</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Phase 1 — Mesh Transport</Text>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, isAdvertising && styles.buttonActive]}
          onPress={isAdvertising ? undefined : handleAdvertise}
        >
          <Text style={styles.buttonText}>
            {isAdvertising ? 'ADVERTISING...' : 'ADVERTISE'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, isDiscovering && styles.buttonActive]}
          onPress={isDiscovering ? undefined : handleDiscover}
        >
          <Text style={styles.buttonText}>
            {isDiscovering ? 'DISCOVERING...' : 'DISCOVER'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.button} onPress={handleSendHello}>
          <Text style={styles.buttonText}>BROADCAST "hello"</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.button, styles.stopButton]} onPress={handleStopAll}>
          <Text style={styles.buttonText}>STOP ALL</Text>
        </TouchableOpacity>
      </View>

      {progress && (
        <View style={styles.progressContainer}>
          <Text style={styles.progressText}>
            Transfer: {Math.round(progress.bytesTransferred / 1024)}KB / {Math.round(progress.totalBytes / 1024)}KB
            {' '}({progress.status})
          </Text>
          <View style={styles.progressBar}>
            <View
              style={[
                styles.progressFill,
                {
                  width: progress.totalBytes > 0
                    ? `${Math.min(100, (progress.bytesTransferred / progress.totalBytes) * 100)}%`
                    : '0%',
                },
              ]}
            />
          </View>
        </View>
      )}

      <Text style={styles.sectionTitle}>
        Peers ({peers.length})
      </Text>

      <FlatList
        data={peers}
        keyExtractor={(p) => p.endpointId}
        renderItem={renderPeer}
        style={styles.peerList}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {isDiscovering ? 'Searching for devices...' : 'Start discovery to find peers'}
          </Text>
        }
      />

      <Text style={styles.sectionTitle}>Event Log</Text>

      <ScrollView ref={logRef} style={styles.logContainer}>
        {logs.map((log, i) => (
          <Text key={i} style={styles.logLine}>
            [{log.timestamp}] {log.message}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1A1A1A',
    padding: 16,
    paddingTop: 60,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFF',
    marginBottom: 16,
    textAlign: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  button: {
    flex: 1,
    backgroundColor: '#FF8C42',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonActive: {
    backgroundColor: '#555',
  },
  stopButton: {
    backgroundColor: '#E0005C',
  },
  buttonText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 12,
  },
  sectionTitle: {
    color: '#AAA',
    fontSize: 13,
    fontWeight: 'bold',
    marginBottom: 6,
    marginTop: 8,
  },
  peerList: {
    maxHeight: 200,
    marginBottom: 8,
  },
  peerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#222',
    borderRadius: 6,
    padding: 10,
    marginBottom: 4,
  },
  peerInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  peerName: {
    color: '#FFF',
    fontSize: 12,
    flex: 1,
  },
  peerState: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  peerActions: {
    flexDirection: 'row',
    gap: 6,
  },
  actionButton: {
    backgroundColor: '#2ECC71',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
  },
  disconnectButton: {
    backgroundColor: '#E74C3C',
  },
  actionText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: 'bold',
  },
  emptyText: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 20,
  },
  progressContainer: {
    backgroundColor: '#222',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  progressText: {
    color: '#FFF',
    fontSize: 11,
    marginBottom: 4,
  },
  progressBar: {
    height: 6,
    backgroundColor: '#444',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#2ECC71',
    borderRadius: 3,
  },
  connected: {
    color: '#8F8',
    fontSize: 12,
    marginBottom: 10,
    textAlign: 'center',
  },
  logContainer: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 10,
  },
  logLine: {
    color: '#0F0',
    fontSize: 11,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    marginBottom: 4,
  },
});

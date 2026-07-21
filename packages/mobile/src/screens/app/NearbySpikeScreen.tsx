import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
} from 'react-native';
import { meshTransport } from '../../nearby/MeshTransport';
import { requestNearbyPermissions } from '../../nearby/NearbyConnections';

const HELLO_WORLD = btoa('hello world from Nearby Connections!');

type LogEntry = { timestamp: string; message: string };

export default function NearbySpikeScreen() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [connectedEndpoints, setConnectedEndpoints] = useState<string[]>([]);

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { timestamp, message }]);
  }, []);

  useEffect(() => {
    addLog('Nearby Connections spike screen mounted');
    addLog(`Platform: ${Platform.OS} ${Platform.Version}`);

    const unsubFound = meshTransport.onFound((e) => {
      addLog(`FOUND: ${e.displayName ?? e.endpointId} (${e.endpointId})`);
    });

    const unsubLost = meshTransport.onLost((e) => {
      addLog(`LOST: ${e.endpointId}`);
    });

    const unsubConnected = meshTransport.onConnected((e) => {
      addLog(`CONNECTED: ${e.endpointId}`);
      meshTransport.getConnectedPeers().then(setConnectedEndpoints);
    });

    const unsubDisconnected = meshTransport.onDisconnected((e) => {
      addLog(`DISCONNECTED: ${e.endpointId}`);
      meshTransport.getConnectedPeers().then(setConnectedEndpoints);
    });

    const unsubData = meshTransport.onData(async (e) => {
      if (!e.data) return;
      const decoded = atob(e.data);
      addLog(`PAYLOAD from ${e.endpointId}: "${decoded}"`);

      try {
        await meshTransport.persistReceivedMessage(e.endpointId, e.data);
        addLog(`Persisted to WatermelonDB ✓`);
      } catch (dbErr: any) {
        addLog(`DB persist error: ${dbErr.message}`);
      }
    });

    return () => {
      unsubFound();
      unsubLost();
      unsubConnected();
      unsubDisconnected();
      unsubData();
      meshTransport.stopAll();
    };
  }, [addLog]);

  const ensurePermissions = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    try {
      const has = await requestNearbyPermissions();
      if (has) {
        addLog('Permissions granted ✓');
      } else {
        addLog('ERROR: Permissions denied');
      }
      return has;
    } catch (e: any) {
      addLog(`Permission request error: ${e.message}`);
      return false;
    }
  };

  const handleAdvertise = async () => {
    const ok = await ensurePermissions();
    if (!ok) return;
    try {
      addLog('Starting advertising...');
      await meshTransport.startAdvertising();
      setIsAdvertising(true);
      addLog('Advertising started');
    } catch (e: any) {
      addLog(`ERROR advertising: ${e.message}`);
    }
  };

  const handleDiscover = async () => {
    const ok = await ensurePermissions();
    if (!ok) return;
    try {
      addLog('Starting discovery...');
      await meshTransport.startDiscovery();
      setIsDiscovering(true);
      addLog('Discovery started');
    } catch (e: any) {
      addLog(`ERROR discovering: ${e.message}`);
    }
  };

  const handleSendHello = async () => {
    try {
      const endpoints = connectedEndpoints.length > 0
        ? connectedEndpoints
        : await meshTransport.getConnectedPeers();

      if (endpoints.length === 0) {
        addLog('ERROR: No connected endpoints to send to');
        return;
      }

      addLog(`Sending "hello world" to ${endpoints.length} endpoint(s)...`);
      await meshTransport.sendToAll(HELLO_WORLD);
      addLog('Payload sent');
    } catch (e: any) {
      addLog(`ERROR sending: ${e.message}`);
    }
  };

  const handleStopAll = async () => {
    try {
      await meshTransport.stopAll();
      setIsAdvertising(false);
      setIsDiscovering(false);
      setConnectedEndpoints([]);
      addLog('All Nearby Connections stopped');
    } catch (e: any) {
      addLog(`ERROR stopping: ${e.message}`);
    }
  };

  const handleRefreshEndpoints = async () => {
    const eps = await meshTransport.getConnectedPeers();
    setConnectedEndpoints(eps);
    addLog(`Connected endpoints: ${eps.length > 0 ? eps.join(', ') : 'none'}`);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Nearby Connections Spike</Text>

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
          <Text style={styles.buttonText}>SEND "hello world"</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.button} onPress={handleRefreshEndpoints}>
          <Text style={styles.buttonText}>REFRESH ENDPOINTS</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={[styles.button, styles.stopButton]} onPress={handleStopAll}>
        <Text style={styles.buttonText}>STOP ALL</Text>
      </TouchableOpacity>

      <Text style={styles.connected}>
        Connected: {connectedEndpoints.length > 0
          ? connectedEndpoints.join(', ')
          : 'none'}
      </Text>

      <ScrollView style={styles.logContainer}>
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
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFF',
    marginBottom: 20,
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
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonActive: {
    backgroundColor: '#555',
  },
  stopButton: {
    backgroundColor: '#E0005C',
    marginBottom: 10,
  },
  buttonText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 13,
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

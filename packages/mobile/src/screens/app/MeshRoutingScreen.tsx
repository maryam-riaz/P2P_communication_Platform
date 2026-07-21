import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  StyleSheet,
  Platform,
  FlatList,
  Alert,
} from 'react-native';
import { meshTransport } from '../../nearby';
import { PeerState, PeerSecurityState } from '../../nearby/types';
import type { PeerInfo, EnvelopeType } from '../../nearby/types';
import { messageRouter, keyExchange } from '../../p2p';
import { logm, errm } from '../../utils/logger';

const SCREEN = 'ROUTING';
const ENVELOPE_TYPES: EnvelopeType[] = ['TEXT', 'IMAGE', 'VIDEO_CHUNK', 'AUDIO', 'SOS', 'CHATBOT'];

interface RoutingLogEntry {
  timestamp: string;
  message: string;
  color?: string;
}

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

function secStateLabel(state: PeerSecurityState): string {
  switch (state) {
    case PeerSecurityState.Trusted: return '🔒';
    case PeerSecurityState.Pending: return '🔐';
    case PeerSecurityState.Mismatch: return '⚠️';
    case PeerSecurityState.Unknown: return '🔓';
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

export default function MeshRoutingScreen() {
  const [logs, setLogs] = useState<RoutingLogEntry[]>([]);
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [messageText, setMessageText] = useState('');
  const [messageType, setMessageType] = useState<EnvelopeType>('TEXT');
  const [deviceId, setDeviceId] = useState(messageRouter.getDeviceId());
  const [statusInfo, setStatusInfo] = useState({ dedupSize: 0, connectedCount: 0 });
  const logRef = useRef<ScrollView>(null);
  const statusInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = useCallback((message: string, color?: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { timestamp, message, color }]);
    setTimeout(() => logRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  const showError = useCallback((title: string, message: string) => {
    errm(SCREEN, title, message);
    addLog(`!! ${title}: ${message}`, '#E0005C');
    Alert.alert(title, message);
  }, [addLog]);

  const updatePeers = useCallback(() => {
    setPeers(meshTransport.getAllPeers());
  }, []);

  const updateStatus = useCallback(async () => {
    const connected = await meshTransport.getConnectedPeers();
    setStatusInfo({
      dedupSize: messageRouter.getDedupSize(),
      connectedCount: connected.length,
    });
  }, []);

  useEffect(() => {
    logm(SCREEN, '=== MeshRoutingScreen mounted ===');
    addLog('Phase 2 — Multi-Hop Routing');
    addLog(`Device ID: ${deviceId}`);

    const unsubFound = meshTransport.onPeerFound((e) => {
      addLog(`FOUND: ${e.displayName} (${e.peerId})`);
      updatePeers();
    });

    const unsubLost = meshTransport.onPeerLost((e) => {
      addLog(`LOST: ${e.peerId}`);
      updatePeers();
    });

    const unsubConnected = meshTransport.onPeerConnected((e) => {
      addLog(`CONNECTED: ${e.peerId}`, '#2ECC71');
      updatePeers();
      updateStatus();
    });

    const unsubDisconnected = meshTransport.onPeerDisconnected((e) => {
      addLog(`DISCONNECTED: ${e.peerId}${e.unexpected ? ' (unexpected)' : ''}`, '#E74C3C');
      updatePeers();
      updateStatus();
    });

    const unsubData = meshTransport.onPayloadReceived((e) => {
      addLog(`RAW PAYLOAD from ${e.peerId} (${e.data.length} chars)`);
    });

    const unsubReconnecting = meshTransport.onReconnecting((e) => {
      addLog(`RECONNECTING to ${e.peerId} (${e.attempt}/${e.maxAttempts})`, '#FFA500');
      updatePeers();
    });

    const unsubDecrypted = messageRouter.subscribeDecrypted((senderId, plaintext) => {
      addLog(
        `DECRYPTED from ${senderId}: ${plaintext.substring(0, 60)}${plaintext.length > 60 ? '...' : ''}`,
        '#00BFFF',
      );
    });

    statusInterval.current = setInterval(() => updateStatus(), 3000);

    return () => {
      logm(SCREEN, '=== MeshRoutingScreen unmounting ===');
      unsubFound();
      unsubLost();
      unsubConnected();
      unsubDisconnected();
      unsubData();
      unsubReconnecting();
      unsubDecrypted();
      if (statusInterval.current) clearInterval(statusInterval.current);
    };
  }, [addLog, updatePeers, updateStatus, deviceId]);

  const handleAdvertise = async () => {
    try {
      addLog('Starting advertising...');
      await meshTransport.advertise({ deviceName: messageRouter.getDisplayName() });
      setIsAdvertising(true);
      addLog('Advertising started');
    } catch (e: any) {
      showError('Advertise Failed', e?.message || String(e));
    }
  };

  const handleDiscover = async () => {
    try {
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
      addLog(`Connected to ${endpointId}`, '#2ECC71');
      updatePeers();
    } catch (e: any) {
      showError('Connect Failed', e?.message || String(e));
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

  const handleSendMessage = async () => {
    if (!messageText.trim()) {
      addLog('!! Enter message text first', '#E0005C');
      return;
    }
    try {
      const envs = await messageRouter.sendMessage(messageType, messageText);
      const env = envs[0];
      addLog(
        `SENT [${messageType}] ${env.message_id.substring(0, 8)}... ` +
        `(ttl=${env.ttl}) ` +
        `${peers.length > 0 ? '→ broadcast' : '→ queued'}`,
        '#2ECC71',
      );
      setMessageText('');
    } catch (e: any) {
      showError('Send Failed', e?.message || String(e));
    }
  };

  const handleSendToPeer = async (endpointId: string) => {
    if (!messageText.trim()) {
      addLog('!! Enter message text first', '#E0005C');
      return;
    }
    try {
      const env = await messageRouter.sendToPeer(endpointId, messageType, messageText);
      addLog(`SENT [${messageType}] ${env.message_id.substring(0, 8)}... → direct to ${endpointId}`, '#2ECC71');
    } catch (e: any) {
      showError('Send To Peer Failed', e?.message || String(e));
    }
  };

  const handleStopAll = async () => {
    try {
      await meshTransport.stopAll();
      setIsAdvertising(false);
      setIsDiscovering(false);
      setPeers([]);
      addLog('All transport stopped');
      await updateStatus();
    } catch (e: any) {
      showError('Stop Failed', e?.message || String(e));
    }
  };

  const renderPeer = ({ item }: { item: PeerInfo }) => {
    const secState = keyExchange.hasPeerKey(item.endpointId)
      ? PeerSecurityState.Trusted
      : PeerSecurityState.Unknown;
    return (
    <View style={styles.peerRow}>
      <View style={styles.peerInfo}>
        <Text style={styles.peerName} numberOfLines={1}>
          {secStateLabel(secState)} {item.displayName || item.endpointId}
        </Text>
        <Text style={[styles.peerStateLabel, { color: stateColor(item.state) }]}>
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
          <>
            <TouchableOpacity
              style={[styles.actionButton, styles.sendToButton]}
              onPress={() => handleSendToPeer(item.endpointId)}
            >
              <Text style={styles.actionText}>SEND TO</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, styles.disconnectButton]}
              onPress={() => handleDisconnect(item.endpointId)}
            >
              <Text style={styles.actionText}>DISCONNECT</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
    );
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Phase 2 — Multi-Hop Routing</Text>
      <Text style={styles.subtitle}>Device: {deviceId}</Text>

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
        <TouchableOpacity style={[styles.button, styles.stopButton]} onPress={handleStopAll}>
          <Text style={styles.buttonText}>STOP ALL</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statusRow}>
        <Text style={styles.statusText}>
          Peers: {peers.length} | Connected: {statusInfo.connectedCount} | Dedup: {statusInfo.dedupSize}
        </Text>
      </View>

      {/* Message input */}
      <View style={styles.sendContainer}>
        <View style={styles.typeRow}>
          {ENVELOPE_TYPES.map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.typeChip, messageType === t && styles.typeChipActive]}
              onPress={() => setMessageType(t)}
            >
              <Text style={[styles.typeChipText, messageType === t && styles.typeChipTextActive]}>
                {t}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={messageText}
            onChangeText={setMessageText}
            placeholder="Type message to send..."
            placeholderTextColor="#666"
          />
          <TouchableOpacity style={styles.sendButton} onPress={handleSendMessage}>
            <Text style={styles.sendButtonText}>BROADCAST</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Peer list */}
      <Text style={styles.sectionTitle}>Peers ({peers.length})</Text>
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

      {/* Routing log */}
      <Text style={styles.sectionTitle}>Routing Log</Text>
      <ScrollView ref={logRef} style={styles.logContainer}>
        {logs.map((log, i) => (
          <Text key={i} style={[styles.logLine, log.color ? { color: log.color } : undefined]}>
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
    padding: 12,
    paddingTop: 50,
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFF',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 11,
    color: '#888',
    textAlign: 'center',
    marginBottom: 10,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 8,
  },
  button: {
    flex: 1,
    backgroundColor: '#FF8C42',
    padding: 10,
    borderRadius: 6,
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
    fontSize: 11,
  },
  statusRow: {
    backgroundColor: '#222',
    borderRadius: 6,
    padding: 6,
    marginBottom: 8,
  },
  statusText: {
    color: '#AAA',
    fontSize: 11,
    textAlign: 'center',
  },
  sendContainer: {
    backgroundColor: '#222',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  typeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 6,
  },
  typeChip: {
    backgroundColor: '#333',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  typeChipActive: {
    backgroundColor: '#FF8C42',
  },
  typeChipText: {
    color: '#888',
    fontSize: 9,
    fontWeight: 'bold',
  },
  typeChipTextActive: {
    color: '#FFF',
  },
  inputRow: {
    flexDirection: 'row',
    gap: 6,
  },
  input: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 6,
    padding: 8,
    color: '#FFF',
    fontSize: 12,
  },
  sendButton: {
    backgroundColor: '#2ECC71',
    borderRadius: 6,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  sendButtonText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 10,
  },
  sectionTitle: {
    color: '#AAA',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
    marginTop: 6,
  },
  peerList: {
    maxHeight: 160,
    marginBottom: 6,
  },
  peerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#222',
    borderRadius: 6,
    padding: 8,
    marginBottom: 4,
  },
  peerInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  peerName: {
    color: '#FFF',
    fontSize: 11,
    flex: 1,
  },
  peerStateLabel: {
    fontSize: 9,
    fontWeight: 'bold',
  },
  peerActions: {
    flexDirection: 'row',
    gap: 4,
  },
  actionButton: {
    backgroundColor: '#2ECC71',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  sendToButton: {
    backgroundColor: '#3498DB',
  },
  disconnectButton: {
    backgroundColor: '#E74C3C',
  },
  actionText: {
    color: '#FFF',
    fontSize: 9,
    fontWeight: 'bold',
  },
  emptyText: {
    color: '#666',
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 12,
  },
  logContainer: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 6,
    padding: 8,
  },
  logLine: {
    color: '#0F0',
    fontSize: 10,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    marginBottom: 2,
  },
});

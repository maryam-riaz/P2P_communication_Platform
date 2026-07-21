import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Platform,
  FlatList,
} from 'react-native';
import { meshTransport } from '../../nearby';
import { PeerSecurityState } from '../../nearby/types';
import { keyManager, keyExchange } from '../../crypto';
import { messageRouter } from '../../p2p';
import { logm } from '../../utils/logger';

const SCREEN = 'SECURITY';

interface KeyDisplayPeer {
  peerId: string;
  fingerprint: string;
  state: PeerSecurityState;
}

export default function SecurityScreen() {
  const [fingerprint, setFingerprint] = useState('');
  const [keyLoaded, setKeyLoaded] = useState(false);
  const [peerKeys, setPeerKeys] = useState<KeyDisplayPeer[]>([]);

  const refresh = useCallback(() => {
    try {
      setFingerprint(keyManager.getFingerprint());
      setKeyLoaded(true);
    } catch {
      setKeyLoaded(false);
    }

    const allPeers = keyExchange.getAllPeerKeys();
    setPeerKeys(
      allPeers.map((p) => ({
        peerId: p.peerId,
        fingerprint: p.fingerprint,
        state: PeerSecurityState.Trusted,
      })),
    );
  }, []);

  useEffect(() => {
    logm(SCREEN, '=== SecurityScreen mounted ===');
    refresh();

    const unsubConnected = meshTransport.onPeerConnected(() => refresh());
    const unsubPayload = meshTransport.onPayloadReceived(() => {
      setTimeout(refresh, 100);
    });

    return () => {
      unsubConnected();
      unsubPayload();
    };
  }, [refresh]);

  const renderKeyRow = ({ item }: { item: KeyDisplayPeer }) => (
    <View style={styles.row}>
      <Text style={styles.rowPeerId}>{item.peerId}</Text>
      <Text style={styles.rowFingerprint}>{secStateLabel(item.state)} {item.fingerprint.substring(0, 16)}...</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Phase 3 — Security Layer</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Device Key</Text>
        {keyLoaded ? (
          <>
            <Text style={styles.label}>Fingerprint (SHA-512/32)</Text>
            <Text style={styles.fingerprint}>{fingerprint}</Text>
            <Text style={styles.label}>Device ID</Text>
            <Text style={styles.mono}>{messageRouter.getDeviceId()}</Text>
          </>
        ) : (
          <Text style={styles.warning}>Key not loaded. Initialize app first.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Known Peers ({peerKeys.length})</Text>
        {peerKeys.length === 0 ? (
          <Text style={styles.muted}>No peer keys exchanged yet. Connect to a peer first.</Text>
        ) : (
          <FlatList
            data={peerKeys}
            keyExtractor={(p) => p.peerId}
            renderItem={renderKeyRow}
            style={styles.list}
          />
        )}
      </View>

      <View style={styles.legendCard}>
        <Text style={styles.cardTitle}>Legend</Text>
        <Text style={styles.legendItem}>
          🔒 Trusted — Key exchanged, messages encrypted
        </Text>
        <Text style={styles.legendItem}>
          🔐 Pending — Key exchange in progress
        </Text>
        <Text style={styles.legendItem}>
          ⚠️ Mismatch — Key changed since last seen
        </Text>
        <Text style={styles.legendItem}>
          🔓 Unknown — No key exchanged, messages in plaintext
        </Text>
      </View>
    </View>
  );
}

function secStateLabel(state: PeerSecurityState): string {
  switch (state) {
    case PeerSecurityState.Trusted: return '🔒';
    case PeerSecurityState.Pending: return '🔐';
    case PeerSecurityState.Mismatch: return '⚠️';
    case PeerSecurityState.Unknown: return '🔓';
  }
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
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#222',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  cardTitle: {
    color: '#FF8C42',
    fontSize: 13,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  label: {
    color: '#888',
    fontSize: 10,
    marginTop: 6,
  },
  fingerprint: {
    color: '#0F0',
    fontSize: 10,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    backgroundColor: '#111',
    padding: 8,
    borderRadius: 4,
    marginTop: 2,
  },
  mono: {
    color: '#FFF',
    fontSize: 11,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    marginTop: 2,
  },
  warning: {
    color: '#FFA500',
    fontSize: 12,
  },
  muted: {
    color: '#666',
    fontSize: 11,
    fontStyle: 'italic',
  },
  list: {
    maxHeight: 200,
  },
  row: {
    backgroundColor: '#111',
    borderRadius: 4,
    padding: 8,
    marginBottom: 4,
  },
  rowPeerId: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: 'bold',
  },
  rowFingerprint: {
    color: '#AAA',
    fontSize: 10,
    marginTop: 2,
  },
  legendCard: {
    backgroundColor: '#222',
    borderRadius: 8,
    padding: 12,
  },
  legendItem: {
    color: '#AAA',
    fontSize: 11,
    marginBottom: 4,
  },
});

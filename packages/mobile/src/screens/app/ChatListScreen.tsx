import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { Q } from '@nozbe/watermelondb';
import { database } from '../../db';
import { Conversation, ConversationParticipant, Message } from '../../db/models';
import { meshTransport } from '../../nearby';
import type { PeerInfo } from '../../nearby/types';
import { PeerState } from '../../nearby/types';
import { messageRouter } from '../../p2p';

interface EnrichedConversation {
  conversationId: string;
  peerName: string;
  peerId: string;
  lastMessagePreview: string | null;
  lastMessageAt: number | null;
  unreadCount: number;
}

function formatTimestamp(unixMs: number | null): string {
  if (!unixMs) return '';
  const now = Date.now();
  const diff = now - unixMs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(unixMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatListScreen() {
  const navigation = useNavigation<any>();
  const [conversations, setConversations] = useState<EnrichedConversation[]>([]);
  const [discoveredPeers, setDiscoveredPeers] = useState<PeerInfo[]>([]);
  const [connectedPeerIds, setConnectedPeerIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  const loadConversations = useCallback(async () => {
    try {
      const convos = await database.get<Conversation>('conversations').query().fetch();
      const enriched: EnrichedConversation[] = [];

      for (const c of convos) {
        const participants = await database.get<ConversationParticipant>('conversation_participants')
          .query(Q.where('conversation_id', c.conversationId))
          .fetch();

        const otherParticipant = participants.find((p) => p.peerId !== messageRouter.getDeviceId());
        const selfParticipant = participants.find((p) => p.peerId === messageRouter.getDeviceId());
        const peerName = otherParticipant?.peerName || 'Unknown';
        const peerId = otherParticipant?.peerId || '';
        const lastRead = selfParticipant?.lastReadAt || 0;

        const unreadMessages = await database.get<Message>('messages')
          .query(
            Q.where('conversation_id', c.conversationId),
            Q.where('sender_id', Q.notEq(messageRouter.getDeviceId())),
            Q.where('created_at', Q.gt(new Date(lastRead))),
          )
          .fetchCount();

        enriched.push({
          conversationId: c.conversationId,
          peerName,
          peerId,
          lastMessagePreview: c.lastMessagePreview || null,
          lastMessageAt: c.lastMessageAt || null,
          unreadCount: unreadMessages,
        });
      }

      enriched.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
      setConversations(enriched);
    } catch (err) {
      console.error('[ChatList] loadConversations error:', err);
    }
  }, []);

  const refreshPeers = useCallback(() => {
    const all = meshTransport.getAllPeers();
    setDiscoveredPeers(all);
    meshTransport.getConnectedPeers().then((connected) => {
      setConnectedPeerIds(new Set(connected.map((p) => p.endpointId)));
    }).catch(() => {});
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadConversations();

      const unsubFound = meshTransport.onPeerFound(() => refreshPeers());
      const unsubLost = meshTransport.onPeerLost(() => refreshPeers());
      const unsubConnected = meshTransport.onPeerConnected(() => refreshPeers());
      const unsubDisconnected = meshTransport.onPeerDisconnected(() => refreshPeers());

      refreshPeers();

      const interval = setInterval(loadConversations, 3000);

      return () => {
        unsubFound();
        unsubLost();
        unsubConnected();
        unsubDisconnected();
        clearInterval(interval);
      };
    }, [loadConversations, refreshPeers]),
  );

  const filteredConversations = conversations.filter((c) =>
    c.peerName.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const filteredPeers = discoveredPeers.filter((p) =>
    p.displayName.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const openChat = async (peer: PeerInfo) => {
    const session = messageRouter.getPeerSessionByEndpoint(peer.endpointId);
    const displayName = session?.displayName || peer.displayName;
    const peerId = session?.fingerprint || peer.endpointId;

    // Reuse existing conversation if one exists for this peer
    let conversationId = await messageRouter.lookupConversationByPeer(peerId);
    if (!conversationId) {
      conversationId = `conv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    navigation.navigate('Chat', {
      conversationId,
      endpointId: peer.endpointId,
      peerId,
      recipientName: displayName,
    });
  };

  const openConversation = (conv: EnrichedConversation) => {
    const session = messageRouter.getPeerSession(conv.peerId);
    const endpointId = session?.endpointId || '';
    navigation.navigate('Chat', {
      conversationId: conv.conversationId,
      endpointId,
      peerId: conv.peerId,
      recipientName: conv.peerName,
    });
  };

  const renderChatItem = ({ item }: { item: EnrichedConversation }) => {
    return (
      <TouchableOpacity
        style={styles.chatItem}
        onPress={() => openConversation(item)}
      >
        <View style={styles.avatarContainer}>
          <MaterialCommunityIcons name="account-circle" size={40} color="#FF8C42" />
        </View>
        <View style={styles.chatContent}>
          <View style={styles.chatHeader}>
            <Text style={styles.name}>{item.peerName}</Text>
            <Text style={styles.timestamp}>{formatTimestamp(item.lastMessageAt)}</Text>
          </View>
          <Text style={styles.lastMessage} numberOfLines={1}>
            {item.lastMessagePreview || 'No messages yet'}
          </Text>
        </View>
        {item.unreadCount > 0 && (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadText}>{item.unreadCount}</Text>
          </View>
        )}
        <MaterialCommunityIcons name="chevron-right" size={24} color="#666" />
      </TouchableOpacity>
    );
  };

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <MaterialCommunityIcons name="message-off-outline" size={64} color="#333" />
      <Text style={styles.emptyTitle}>No conversations yet</Text>
      <Text style={styles.emptySubtitle}>
        Discovered peers will appear above. Select one to start a secure chat.
      </Text>
    </View>
  );

  const renderHeader = () => (
    <View>
      <View style={styles.searchContainer}>
        <MaterialCommunityIcons name="magnify" size={20} color="#666" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name..."
          placeholderTextColor="#666"
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
      </View>

      {filteredPeers.length > 0 && (
        <View style={styles.peersContainer}>
          <Text style={styles.sectionHeader}>DISCOVERED PEERS NEARBY</Text>
          <FlatList
            horizontal
            data={filteredPeers}
            keyExtractor={(item) => item.endpointId}
            renderItem={({ item }) => {
              const isConnected = connectedPeerIds.has(item.endpointId);
              const dotColor = isConnected ? '#2ECC71' : '#757575';
              return (
                <TouchableOpacity
                  style={styles.peerCard}
                  onPress={() => openChat(item)}
                >
                  <View style={styles.peerAvatarWrapper}>
                    <View style={[styles.peerAvatar, { borderColor: '#FF8C42' }]}>
                      <MaterialCommunityIcons name="account-circle" size={24} color="#FF8C42" />
                    </View>
                    <View style={[styles.activeDotPeer, { backgroundColor: dotColor }]} />
                  </View>
                  <Text style={styles.peerName} numberOfLines={1}>
                    {(() => {
                      const session = messageRouter.getPeerSessionByEndpoint(item.endpointId);
                      return session?.displayName || item.displayName || 'Unknown';
                    })()}
                  </Text>
                </TouchableOpacity>
              );
            }}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.peersListContent}
          />
        </View>
      )}

      {conversations.length > 0 && (
        <Text style={[styles.sectionHeader, { marginTop: 16, marginLeft: 16 }]}>RECENT MESSAGES</Text>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <TouchableOpacity style={styles.headerContainer} onPress={() => navigation.navigate('Home')}>
        <Text style={styles.sosifyLogo}>* SOSIFY</Text>
      </TouchableOpacity>
      <FlatList
        data={filteredConversations}
        renderItem={renderChatItem}
        keyExtractor={(item) => item.conversationId}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={renderEmpty}
        scrollEnabled
        contentContainerStyle={styles.listContent}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  headerContainer: { paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#1A1A1A' },
  sosifyLogo: { fontSize: 24, fontWeight: 'bold', color: '#FF8C42' },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1A1A1A', marginHorizontal: 16, marginVertical: 12, paddingHorizontal: 12, borderRadius: 24, borderWidth: 1, borderColor: '#333' },
  searchInput: { flex: 1, paddingHorizontal: 12, paddingVertical: 10, color: '#FFF', fontSize: 14 },
  peersContainer: { marginVertical: 8 },
  sectionHeader: { color: '#666', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 10, paddingHorizontal: 16 },
  peersListContent: { paddingHorizontal: 16, gap: 12 },
  peerCard: { width: 80, alignItems: 'center' },
  peerAvatarWrapper: { position: 'relative', marginBottom: 6 },
  peerAvatar: { width: 50, height: 50, borderRadius: 25, borderWidth: 1.5, justifyContent: 'center', alignItems: 'center' },
  activeDotPeer: { position: 'absolute', bottom: 1, right: 1, width: 11, height: 11, borderRadius: 5.5, borderWidth: 1.8, borderColor: '#000000' },
  peerName: { color: '#FFF', fontSize: 11, fontWeight: '600', textAlign: 'center', width: '100%' },
  chatItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1A1A1A' },
  avatarContainer: { position: 'relative', marginRight: 12 },
  chatContent: { flex: 1 },
  chatHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  name: { fontSize: 15, fontWeight: '600', color: '#FFF' },
  timestamp: { fontSize: 12, color: '#666' },
  lastMessage: { fontSize: 13, color: '#999', marginBottom: 2 },
  unreadBadge: { backgroundColor: '#E0005C', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, marginRight: 8 },
  unreadText: { color: '#FFF', fontSize: 11, fontWeight: '600' },
  emptyContainer: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 32, gap: 16 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#555' },
  emptySubtitle: { fontSize: 13, color: '#444', textAlign: 'center', lineHeight: 18 },
  listContent: { paddingBottom: 100 },
});

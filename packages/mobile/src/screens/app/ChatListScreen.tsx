import React, { useState, useEffect, useContext } from 'react';
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
import { useNavigation } from '@react-navigation/native';
import { useService } from '../../hooks/useService';
import { ChatService, Conversation } from '../../services/ChatService';
import { ServiceContext } from '../../context/ServiceContext';
import { throttleTime } from 'rxjs';

function formatTimestamp(unixMs: number): string {
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
  const chatService = useService(ChatService);
  const services = useContext(ServiceContext);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [discoveredPeers, setDiscoveredPeers] = useState<any[]>([]);
  const [onlinePeerIds, setOnlinePeerIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  // 1. Subscribe to active conversation lists
  useEffect(() => {
    const subscription = chatService.observeConversations().subscribe({
      next: (convos) => setConversations(convos),
      error: (err) => console.error('[ChatListScreen] conversation stream error', err),
    });
    return () => subscription.unsubscribe();
  }, [chatService]);

  // 2. Subscribe to active discovered peers from MapService
  useEffect(() => {
    const mapService = services?.mapService;
    if (!mapService) return;
    const subscription = mapService.observePeerLocations()
      .pipe(throttleTime(2000, undefined, { leading: true, trailing: true }))
      .subscribe({
        next: (activePins: any[]) => {
          setDiscoveredPeers(activePins.map((p: any) => ({
            id: p.deviceId,
            name: p.displayName,
            role: p.role
          })));
        },
        error: (err: any) => console.error('[ChatListScreen] active peers stream error', err)
      });
    return () => subscription.unsubscribe();
  }, [services]);

  // 3. Subscribe to active cryptographic connection IDs
  useEffect(() => {
    const subscription = chatService.observeActiveTransportIds()
      .pipe(throttleTime(1000, undefined, { leading: true, trailing: true }))
      .subscribe({
      next: (ids) => {
        console.log('[ChatListScreen] Active connected peer IDs updated:', ids);
        setOnlinePeerIds(ids);
      },
      error: (err) => console.error('[ChatListScreen] active transports stream error', err)
    });
    return () => subscription.unsubscribe();
  }, [chatService]);

  const activePeerIds = new Set(onlinePeerIds);

  const filteredConversations = conversations.filter((c) =>
    c.recipientName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredPeers = discoveredPeers.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const renderChatItem = ({ item }: { item: Conversation }) => {
    const isActive = activePeerIds.has(item.recipientId);
    return (
      <TouchableOpacity
        style={styles.chatItem}
        onPress={() =>
          navigation.navigate('Chat', {
            recipientId: item.recipientId,
            recipientName: item.recipientName,
          })
        }
      >
        <View style={styles.avatarContainer}>
          <MaterialCommunityIcons
            name="account-circle"
            size={40}
            color="#FF8C42"
          />
          {isActive && <View style={styles.activeDot} />}
        </View>
        <View style={styles.chatContent}>
          <View style={styles.chatHeader}>
            <Text style={styles.name}>{item.recipientName}</Text>
            <Text style={styles.timestamp}>{formatTimestamp(item.lastTimestamp)}</Text>
          </View>
          <Text style={styles.lastMessage} numberOfLines={1}>
            {item.lastMessage || 'No messages yet'}
          </Text>
          <View style={styles.metaRow}>
            {item.syncStatus === 'pending' && (
              <Text style={styles.pendingBadge}>⏳ Pending</Text>
            )}
          </View>
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
      {/* Search Input */}
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

      {/* Discovered Peers horizontal slider */}
      {filteredPeers.length > 0 && (
        <View style={styles.peersContainer}>
          <Text style={styles.sectionHeader}>DISCOVERED PEERS NEARBY</Text>
          <FlatList
            horizontal
            data={filteredPeers}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => {
              const isRescuer = item.role === 'responder' || item.role === 'admin';
              const themeColor = isRescuer ? '#E0005C' : '#FF8C42';
              const isConnected = onlinePeerIds.includes(item.id);
              const dotColor = isConnected ? '#2ECC71' : '#757575';
              return (
                <TouchableOpacity
                  style={styles.peerCard}
                  onPress={() =>
                    navigation.navigate('Chat', {
                      recipientId: item.id,
                      recipientName: item.name,
                    })
                  }
                >
                  <View style={styles.peerAvatarWrapper}>
                    <View style={[styles.peerAvatar, { backgroundColor: themeColor + '1A', borderColor: themeColor }]}>
                      <MaterialCommunityIcons
                        name={isRescuer ? 'shield-account' : 'account-circle'}
                        size={24}
                        color={themeColor}
                      />
                    </View>
                    <View style={[styles.activeDotPeer, { backgroundColor: dotColor, shadowColor: dotColor }]} />
                  </View>
                  <Text style={styles.peerName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={[styles.peerRole, { color: themeColor }]}>
                    {isRescuer ? 'Rescuer' : 'Peer'}
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

      <TouchableOpacity
        style={styles.headerContainer}
        onPress={() => navigation.navigate('Home')}
      >
        <Text style={styles.sosifyLogo}>* SOSIFY</Text>
      </TouchableOpacity>

      <FlatList
        data={filteredConversations}
        renderItem={renderChatItem}
        keyExtractor={(item) => item.recipientId}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={renderEmpty}
        scrollEnabled
        contentContainerStyle={styles.listContent}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  headerContainer: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  sosifyLogo: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FF8C42',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    marginHorizontal: 16,
    marginVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#333',
  },
  searchInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#FFF',
    fontSize: 14,
  },
  peersContainer: {
    marginVertical: 8,
  },
  sectionHeader: {
    color: '#666',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 10,
    paddingHorizontal: 16,
  },
  peersListContent: {
    paddingHorizontal: 16,
    gap: 12,
  },
  peerCard: {
    width: 80,
    alignItems: 'center',
  },
  peerAvatarWrapper: {
    position: 'relative',
    marginBottom: 6,
  },
  peerAvatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  peerName: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    width: '100%',
  },
  peerRole: {
    fontSize: 9,
    fontWeight: '600',
    marginTop: 2,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  avatarContainer: {
    position: 'relative',
    marginRight: 12,
  },
  activeDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#2ECC71',
    borderWidth: 2,
    borderColor: '#000000',
    shadowColor: '#2ECC71',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
    elevation: 6,
  },
  activeDotPeer: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 11,
    height: 11,
    borderRadius: 5.5,
    backgroundColor: '#2ECC71',
    borderWidth: 1.8,
    borderColor: '#000000',
    shadowColor: '#2ECC71',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 3,
    elevation: 5,
  },
  chatContent: {
    flex: 1,
  },
  chatHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFF',
  },
  timestamp: {
    fontSize: 12,
    color: '#666',
  },
  lastMessage: {
    fontSize: 13,
    color: '#999',
    marginBottom: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  pendingBadge: {
    fontSize: 11,
    color: '#FF8C42',
  },
  unreadBadge: {
    backgroundColor: '#E0005C',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginRight: 8,
  },
  unreadText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '600',
  },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 40,
    paddingHorizontal: 32,
    gap: 16,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#555',
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#444',
    textAlign: 'center',
    lineHeight: 18,
  },
  listContent: {
    paddingBottom: 100,
  },
});

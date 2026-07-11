import React, { useState, useEffect } from 'react';
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

/**
 * Format a Unix timestamp (ms) as a human-readable relative string.
 * e.g. "Just now", "5 min ago", "10:35 AM"
 */
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

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  // Subscribe to live conversation list from WatermelonDB
  useEffect(() => {
    const subscription = chatService.observeConversations().subscribe({
      next: (convos) => setConversations(convos),
      error: (err) => console.error('[ChatListScreen] conversation stream error', err),
    });
    return () => subscription.unsubscribe();
  }, [chatService]);

  const filtered = conversations.filter((c) =>
    c.recipientName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const renderChatItem = ({ item }: { item: Conversation }) => (
    <TouchableOpacity
      style={styles.chatItem}
      onPress={() =>
        navigation.navigate('ChatScreen', {
          person: { id: item.recipientId, name: item.recipientName, type: 'user' },
        })
      }
    >
      <View style={styles.avatar}>
        <MaterialCommunityIcons
          name="account-circle"
          size={40}
          color="#FF8C42"
        />
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

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <MaterialCommunityIcons name="message-off-outline" size={64} color="#333" />
      <Text style={styles.emptyTitle}>No conversations yet</Text>
      <Text style={styles.emptySubtitle}>
        Discover nearby peers on the map and start a secure chat.
      </Text>
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

      <FlatList
        data={filtered}
        renderItem={renderChatItem}
        keyExtractor={(item) => item.recipientId}
        ListEmptyComponent={renderEmpty}
        scrollEnabled
        contentContainerStyle={filtered.length === 0 ? styles.emptyList : { paddingBottom: 100 }}
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
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  avatar: {
    marginRight: 12,
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
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 16,
  },
  emptyList: {
    flexGrow: 1,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#555',
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#444',
    textAlign: 'center',
    lineHeight: 20,
  },
});

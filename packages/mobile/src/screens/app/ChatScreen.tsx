import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  TextInput,
  TouchableOpacity,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useService } from '../../hooks/useService';
import { ChatService } from '../../services/ChatService';
import { Message } from '../../db/models';

// Keep this in sync with the tabBarStyle used in AppStack.tsx
const DEFAULT_TAB_BAR_STYLE = {
  backgroundColor: '#1A1A1A',
  borderTopColor: '#333',
  borderTopWidth: 1,
  height: 70,
  paddingBottom: 16,
  position: 'absolute' as const,
  bottom: 0,
  left: 0,
  right: 0,
};

/** Map a WatermelonDB Message _raw to the display shape used by this screen. */
interface DisplayMessage {
  id: string;
  senderId: string;
  text: string;
  timestamp: string;
  status: string;
}

function toDisplayMessage(msg: Message, localDeviceId: string): DisplayMessage {
  const raw = msg._raw as any;
  return {
    id: msg.id,
    senderId: raw.sender_id === localDeviceId ? 'user' : 'other',
    text: raw.ciphertext || '',
    timestamp: new Date(raw.created_at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
    status: raw.sync_status || 'pending',
  };
}

export default function ChatScreen({ route, navigation }: any) {
  const chatService = useService(ChatService);

  const person = route?.params?.person || { id: '', name: 'Chat' };
  const recipientId: string = person.id || route?.params?.recipientId || '';
  const recipientName: string = person.name || route?.params?.recipientName || 'Chat';

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [localDeviceId, setLocalDeviceId] = useState('');
  const flatListRef = useRef<FlatList>(null);

  // Resolve local device ID once for message side detection
  useEffect(() => {
    chatService['repository']?.getLocalUser().then((u: any) => {
      if (u) setLocalDeviceId(u._raw?.device_id || '');
    }).catch(() => {});
  }, [chatService]);

  // Subscribe to live messages for this conversation
  useEffect(() => {
    if (!recipientId) return;

    const subscription = chatService
      .observeMessagesByRecipient(recipientId)
      .subscribe({
        next: (dbMessages) => {
          const displayed = dbMessages.map((m) => toDisplayMessage(m, localDeviceId));
          setMessages(displayed);
          // Scroll to bottom on new messages
          setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
        },
        error: (err) => console.error('[ChatScreen] message stream error', err),
      });

    return () => subscription.unsubscribe();
  }, [recipientId, chatService, localDeviceId]);

  // Mark messages as read when screen is focused
  useFocusEffect(
    useCallback(() => {
      if (recipientId) {
        chatService.markAsRead(recipientId).catch(() => {});
      }
    }, [recipientId, chatService])
  );

  // Hide bottom tab bar while this screen is focused
  useFocusEffect(
    useCallback(() => {
      const parent = navigation.getParent();
      parent?.setOptions({ tabBarStyle: { display: 'none' } });
      return () => parent?.setOptions({ tabBarStyle: DEFAULT_TAB_BAR_STYLE });
    }, [navigation])
  );

  const handleSendMessage = async () => {
    if (!inputText.trim() || !recipientId || isSending) return;

    const text = inputText.trim();
    setInputText('');
    setIsSending(true);

    try {
      await chatService.sendMessage(text, recipientId);
    } catch (err) {
      console.error('[ChatScreen] send failed', err);
    } finally {
      setIsSending(false);
    }
  };

  const renderMessageItem = ({ item }: { item: DisplayMessage }) => {
    const isUser = item.senderId === 'user';
    return (
      <View style={[styles.messageContainer, isUser && styles.userMessageContainer]}>
        <View style={[styles.messageBubble, isUser && styles.userMessageBubble]}>
          <Text style={[styles.messageText, isUser && styles.userMessageText]}>
            {item.text}
          </Text>
          <View style={styles.messageFooter}>
            <Text style={[styles.timestamp, isUser && styles.userTimestamp]}>
              {item.timestamp}
            </Text>
            {isUser && (
              <MaterialCommunityIcons
                name={
                  item.status === 'read'
                    ? 'check-all'
                    : item.status === 'sent' || item.status === 'delivered'
                    ? 'check'
                    : 'clock-outline'
                }
                size={12}
                color={item.status === 'read' ? '#02C39A' : '#999'}
                style={{ marginLeft: 4 }}
              />
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      <SafeAreaView style={styles.headerWrapper}>
        <View style={styles.chatHeader}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <MaterialCommunityIcons name="arrow-left" size={24} color="#FF8C42" />
          </TouchableOpacity>
          <MaterialCommunityIcons
            name="account-circle"
            size={40}
            color="#FF8C42"
            style={{ marginLeft: 12 }}
          />
          <View style={styles.userInfo}>
            <Text style={styles.userName}>{recipientName}</Text>
            <Text style={styles.userStatus}>
              {recipientId ? 'Peer-to-peer encrypted' : 'Offline'}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity onPress={() => navigation.navigate('SOSModal')}>
              <View style={styles.sosButton}>
                <MaterialCommunityIcons name="alert" size={20} color="#FFF" />
                <Text style={styles.sosText}>SOS</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      {messages.length === 0 ? (
        <View style={styles.emptyContainer}>
          <MaterialCommunityIcons name="lock-outline" size={40} color="#333" />
          <Text style={styles.emptyText}>
            Messages are end-to-end encrypted.{'\n'}Say hello!
          </Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessageItem}
          keyExtractor={(item) => item.id}
          scrollEnabled
          contentContainerStyle={styles.messageList}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
        />
      )}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.inputWrapper}
        keyboardVerticalOffset={0}
      >
        <SafeAreaView edges={['bottom']} style={styles.inputSafeArea}>
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.input}
              placeholder="Message..."
              placeholderTextColor="#666"
              value={inputText}
              onChangeText={setInputText}
              multiline
              editable={!isSending}
            />
            <TouchableOpacity
              style={[styles.sendButton, inputText.trim() && styles.sendButtonActive]}
              onPress={handleSendMessage}
              disabled={!inputText.trim() || isSending}
            >
              {isSending ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <MaterialCommunityIcons name="send" size={20} color="#FFF" />
              )}
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
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
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1A1A1A',
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  userInfo: {
    flex: 1,
    marginLeft: 12,
  },
  userName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFF',
  },
  userStatus: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 12,
  },
  sosButton: {
    backgroundColor: '#E0005C',
    borderRadius: 25,
    width: 45,
    height: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sosText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyText: {
    color: '#444',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
  inputWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000',
  },
  inputSafeArea: {
    backgroundColor: '#000000',
  },
  messageList: {
    paddingVertical: 12,
    paddingBottom: 90,
  },
  messageContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginVertical: 6,
    justifyContent: 'flex-start',
  },
  userMessageContainer: {
    justifyContent: 'flex-end',
  },
  messageBubble: {
    maxWidth: '75%',
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderBottomLeftRadius: 0,
  },
  userMessageBubble: {
    backgroundColor: '#FF8C42',
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 0,
  },
  messageText: {
    fontSize: 14,
    color: '#FFF',
    lineHeight: 18,
  },
  userMessageText: {
    color: '#FFF',
  },
  messageFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  timestamp: {
    fontSize: 11,
    color: '#999',
  },
  userTimestamp: {
    color: 'rgba(255,255,255,0.7)',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#1A1A1A',
    borderTopWidth: 1,
    borderTopColor: '#333',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    color: '#FFF',
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    maxHeight: 100,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#666',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonActive: {
    backgroundColor: '#FF8C42',
  },
});
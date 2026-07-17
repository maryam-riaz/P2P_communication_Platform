import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  StatusBar,
  Platform,
  ActivityIndicator,
  Modal,
  Linking,
  Alert,
  NativeModules,
  KeyboardAvoidingView,
  Keyboard,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Audio } from 'expo-av';
import { Image } from 'expo-image';
import { useService } from '../../hooks/useService';
import { ChatService } from '../../services/ChatService';
import { Message } from '../../db/models';

interface Attachment {
  uri: string;
  type: 'image' | 'video' | 'audio';
  name: string;
}

/** Map a WatermelonDB Message _raw to the display shape used by this screen. */
interface DisplayMessage {
  id: string;
  senderId: string;
  text: string;
  timestamp: string;
  status: string;
  attachment?: Attachment;
}

function toDisplayMessage(msg: Message, localDeviceId: string): DisplayMessage {
  const raw = msg._raw as any;
  let text = raw.ciphertext || '';
  let attachment: Attachment | undefined = undefined;

  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      text = parsed.text || '';
      attachment = parsed.attachment;
    } catch (e) {
      // Treat as plain text fallback
    }
  }

  return {
    id: msg.id,
    senderId: raw.sender_id === localDeviceId ? 'user' : 'other',
    text,
    timestamp: new Date(raw.created_at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
    status: raw.sync_status || 'pending',
    attachment,
  };
}

export default function ChatScreen({ route, navigation }: any) {
  const chatService = useService(ChatService);
  const insets = useSafeAreaInsets();

  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  useEffect(() => {
    const showSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setIsKeyboardOpen(true)
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setIsKeyboardOpen(false)
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const bottomPadding = isKeyboardOpen ? 0 : insets.bottom;

  const person = route?.params?.person || { id: '', name: 'Chat' };
  const recipientId: string = person.id || route?.params?.recipientId || '';
  const recipientName: string = person.name || route?.params?.recipientName || 'Chat';

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [localDeviceId, setLocalDeviceId] = useState('');
  const [isPeerActive, setIsPeerActive] = useState(false);
  const [displayName, setDisplayName] = useState(recipientName);
  const flatListRef = useRef<FlatList>(null);

  // Fetch true peer display name if cached/different
  useEffect(() => {
    if (!recipientId) return;
    chatService['repository']?.getPeer(recipientId).then((peer: any) => {
      if (peer && peer.displayName) {
        setDisplayName(peer.displayName);
      }
    }).catch(() => { });
  }, [recipientId, chatService]);

  // Subscribe to active connection status for this peer
  useEffect(() => {
    if (!recipientId) return;
    const subscription = chatService.observeActiveTransportIds().subscribe({
      next: (activeIds) => {
        setIsPeerActive(activeIds.includes(recipientId));
      },
      error: (err) => console.error('[ChatScreen] active status check error', err),
    });
    return () => subscription.unsubscribe();
  }, [recipientId, chatService]);

  // Native Audio Playback/Recording state
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [audioProgress, setAudioProgress] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordingInterval = useRef<any>(null);

  // Clean up audio resources on unmount
  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => { });
      }
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => { });
      }
      clearInterval(recordingInterval.current);
    };
  }, []);

  // Full Screen Image Preview modal
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // Resolve local device ID once for message side detection
  useEffect(() => {
    chatService['repository']?.getLocalUser().then((u: any) => {
      if (u) setLocalDeviceId(u._raw?.device_id || '');
    }).catch(() => { });
  }, [chatService]);

  // Subscribe to live messages for this conversation
  useEffect(() => {
    if (!recipientId) return;

    const subscription = chatService
      .observeMessagesByRecipient(recipientId, localDeviceId)
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
        chatService.markAsRead(recipientId).catch(() => { });
      }
    }, [recipientId, chatService])
  );
  // Hide bottom tab bar while this screen is focused
  useFocusEffect(
    useCallback(() => {
      const parent = navigation.getParent();
      parent?.setOptions({ tabBarStyle: { display: 'none' } });
      return () => parent?.setOptions({ tabBarStyle: undefined });
    }, [navigation])
  );

  const checkWifiBeforeSend = async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      try {
        if (NativeModules.WifiDirect && typeof NativeModules.WifiDirect.isWifiEnabled === 'function') {
          const wifiEnabled = await NativeModules.WifiDirect.isWifiEnabled();
          if (!wifiEnabled) {
            Alert.alert(
              'Wi-Fi Required',
              'Wi-Fi is turned off. Please turn it on to send messages offline.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Turn On', onPress: () => {
                    if (NativeModules.WifiDirect && typeof NativeModules.WifiDirect.setWifiEnabled === 'function') {
                      NativeModules.WifiDirect.setWifiEnabled(true).catch(console.error);
                    }
                  }
                }
              ]
            );
            return false;
          }
        }
      } catch (err) {
        console.warn('Failed to check Wi-Fi state:', err);
      }
    }
    return true;
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() || !recipientId || isSending) return;

    const isWifiOk = await checkWifiBeforeSend();
    if (!isWifiOk) return;

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

  const handlePickAttachment = async () => {
    if (isPicking || isSending) return;
    const isWifiOk = await checkWifiBeforeSend();
    if (!isWifiOk) return;
    setIsPicking(true);

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        setIsPicking(false);
        return;
      }

      const asset = result.assets[0];
      let type: 'image' | 'video' | 'audio' = 'image';
      const mime = asset.mimeType || '';
      const nameLower = asset.name.toLowerCase();

      if (mime.startsWith('image/') || nameLower.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
        type = 'image';
      } else if (mime.startsWith('video/') || nameLower.match(/\.(mp4|mov|m4v|3gp|avi|mkv)$/)) {
        type = 'video';
      } else if (mime.startsWith('audio/') || nameLower.match(/\.(mp3|wav|m4a|aac|ogg|flac)$/)) {
        type = 'audio';
      }

      setIsSending(true);

      await chatService.sendMessage('', recipientId, {
        uri: asset.uri,
        type,
        name: asset.name || `doc-${Date.now()}`,
      });

    } catch (err) {
      console.error('[ChatScreen] Attachment processing failed:', err);
    } finally {
      setIsPicking(false);
      setIsSending(false);
    }
  };

  const handleLaunchCamera = () => {
    if (isPicking || isSending) return;

    Alert.alert(
      'Select Option',
      'Would you like to take a photo or record a video?',
      [
        {
          text: 'Take Photo',
          onPress: () => launchCameraWithOptions('image'),
        },
        {
          text: 'Record Video',
          onPress: () => launchCameraWithOptions('video'),
        },
        {
          text: 'Cancel',
          style: 'cancel',
        },
      ]
    );
  };

  const launchCameraWithOptions = async (mode: 'image' | 'video') => {
    const isWifiOk = await checkWifiBeforeSend();
    if (!isWifiOk) return;

    try {
      const cameraPermission = await ImagePicker.requestCameraPermissionsAsync();
      if (cameraPermission.status !== 'granted') {
        Alert.alert(
          'Permission Denied',
          'Camera permission is required to capture media.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Settings', onPress: () => Linking.openSettings() }
          ]
        );
        return;
      }

      if (mode === 'video') {
        const microPermission = await Audio.requestPermissionsAsync();
        if (microPermission.status !== 'granted') {
          Alert.alert(
            'Permission Denied',
            'Microphone permission is required to record videos.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Settings', onPress: () => Linking.openSettings() }
            ]
          );
          return;
        }
      }

      setIsPicking(true);

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: mode === 'video' ? ['videos'] : ['images'],
        quality: 0.4, // Compress image to prevent Out-of-Memory (OOM) crashes
        videoMaxDuration: 15, // Limit video recording to 15 seconds to prevent OOM
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        setIsPicking(false);
        return;
      }

      const asset = result.assets[0];
      const type = asset.type === 'video' ? 'video' : 'image';

      setIsSending(true);

      const extension = type === 'video' ? 'mp4' : 'jpg';
      const name = asset.fileName || `camera-${Date.now()}.${extension}`;

      await chatService.sendMessage('', recipientId, {
        uri: asset.uri,
        type,
        name,
      });

    } catch (err) {
      console.error('[ChatScreen] Camera capture processing failed:', err);
    } finally {
      setIsPicking(false);
      setIsSending(false);
    }
  };

  const startRecording = async () => {
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        await Linking.openSettings();
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      console.log('[Audio Recorder] Starting native audio recording...');
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      recordingRef.current = recording;
      setIsRecording(true);
      setRecordingDuration(0);

      recordingInterval.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('[Audio Recorder] Start recording failed:', err);
    }
  };

  const stopAndSendRecording = async () => {
    if (!recordingRef.current) return;

    const isWifiOk = await checkWifiBeforeSend();
    if (!isWifiOk) {
      clearInterval(recordingInterval.current);
      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch { }
      recordingRef.current = null;
      setIsRecording(false);
      setRecordingDuration(0);
      return;
    }

    clearInterval(recordingInterval.current);
    const recording = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    setRecordingDuration(0);

    try {
      console.log('[Audio Recorder] Stopping recording...');
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (!uri) return;

      setIsSending(true);

      const fileName = `voice-note-${Date.now()}.m4a`;
      await chatService.sendMessage('', recipientId, {
        uri,
        type: 'audio',
        name: fileName,
      });
    } catch (err) {
      console.error('[Audio Recorder] Stop and send failed:', err);
    } finally {
      setIsSending(false);
    }
  };

  const cancelRecording = async () => {
    if (!recordingRef.current) return;

    clearInterval(recordingInterval.current);
    const recording = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    setRecordingDuration(0);

    try {
      console.log('[Audio Recorder] Discarding recording...');
      await recording.stopAndUnloadAsync();
    } catch (err) {
      console.warn('[Audio Recorder] Cancel cleanup failed:', err);
    }
  };

  const toggleAudioPlayback = async (msgId: string, audioUri: string) => {
    try {
      if (playingAudioId === msgId) {
        // Pause
        if (soundRef.current) {
          await soundRef.current.pauseAsync();
          setPlayingAudioId(null);
        }
      } else {
        // Stop previous sound
        if (soundRef.current) {
          try {
            await soundRef.current.stopAsync();
            await soundRef.current.unloadAsync();
          } catch (e) { }
          soundRef.current = null;
        }

        console.log('[Audio Player] Loading audio note for playback...');
        const { sound } = await Audio.Sound.createAsync(
          { uri: audioUri },
          { shouldPlay: true },
          (status) => {
            if (status.isLoaded) {
              if (status.durationMillis && status.durationMillis > 0) {
                const progress = (status.positionMillis / status.durationMillis) * 100;
                setAudioProgress(progress);
              }
              if (status.didJustFinish) {
                setPlayingAudioId(null);
                setAudioProgress(0);
                if (soundRef.current) {
                  soundRef.current.unloadAsync().catch(() => { });
                  soundRef.current = null;
                }
              }
            }
          }
        );
        soundRef.current = sound;
        setPlayingAudioId(msgId);
        setAudioProgress(0);
      }
    } catch (err) {
      console.error('[Audio Player] Playback toggle failed:', err);
    }
  };

  const renderAttachment = (attachment: Attachment, msgId: string) => {
    if (attachment.type === 'image') {
      return (
        <TouchableOpacity onPress={() => setPreviewImage(attachment.uri)}>
          <Image
            source={{ uri: attachment.uri }}
            style={styles.imageAttachment}
            contentFit="cover"
          />
        </TouchableOpacity>
      );
    }

    if (attachment.type === 'audio') {
      const isCurrentPlaying = playingAudioId === msgId;
      return (
        <View style={styles.audioContainer}>
          <TouchableOpacity
            style={styles.audioPlayButton}
            onPress={() => toggleAudioPlayback(msgId, attachment.uri)}
          >
            <MaterialCommunityIcons
              name={isCurrentPlaying ? 'pause' : 'play'}
              size={24}
              color="#FF8C42"
            />
          </TouchableOpacity>
          <View style={styles.audioWaveformContainer}>
            <Text style={styles.audioText} numberOfLines={1}>
              🎵 {attachment.name}
            </Text>
            <View style={styles.audioTrack}>
              <View
                style={[
                  styles.audioFill,
                  { width: `${isCurrentPlaying ? audioProgress : 0}%` },
                ]}
              />
            </View>
          </View>
        </View>
      );
    }

    if (attachment.type === 'video') {
      return (
        <View style={styles.videoContainer}>
          <View style={styles.videoPlaceholder}>
            <MaterialCommunityIcons name="video" size={32} color="#FFF" />
            <Text style={styles.videoText} numberOfLines={1}>
              🎥 {attachment.name}
            </Text>
          </View>
          <TouchableOpacity style={styles.videoPlayOverlay}>
            <MaterialCommunityIcons name="play-circle-outline" size={48} color="#FF8C42" />
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={styles.fileContainer}>
        <MaterialCommunityIcons name="file-document-outline" size={24} color="#FF8C42" />
        <Text style={styles.fileText} numberOfLines={1}>
          {attachment.name}
        </Text>
      </View>
    );
  };

  const renderMessageItem = ({ item }: { item: DisplayMessage }) => {
    const isUser = item.senderId === 'user';
    return (
      <View style={[styles.messageContainer, isUser && styles.userMessageContainer]}>
        <View style={[styles.messageBubble, isUser && styles.userMessageBubble]}>
          {item.attachment && renderAttachment(item.attachment, item.id)}
          {item.text.trim() !== '' && (
            <Text style={[styles.messageText, isUser && styles.userMessageText]}>
              {item.text}
            </Text>
          )}
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
    <KeyboardAvoidingView
      behavior="padding"
      style={styles.container}
      keyboardVerticalOffset={0}
    >
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
            <Text style={styles.userName}>{displayName}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
              <View style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: isPeerActive ? '#2ECC71' : '#757575',
                marginRight: 6
              }} />
              <Text style={styles.userStatus}>
                {isPeerActive ? 'Active' : 'Inactive'}
              </Text>
            </View>
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
          style={{ flex: 1 }}
          contentContainerStyle={styles.messageList}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
        />
      )}

      <View style={[styles.inputWrapper, { paddingBottom: bottomPadding }]}>
        <View style={styles.inputContainer}>
              {isRecording ? (
                <>
                  <TouchableOpacity
                    style={styles.cancelRecordButton}
                    onPress={cancelRecording}
                  >
                    <MaterialCommunityIcons name="trash-can-outline" size={24} color="#FF3B30" />
                  </TouchableOpacity>

                  <View style={styles.recordingIndicator}>
                    <View style={styles.recordingDot} />
                    <Text style={styles.recordingText}>
                      Recording {Math.floor(recordingDuration / 60)}:{('0' + (recordingDuration % 60)).slice(-2)}
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={[styles.sendButton, styles.sendButtonActive]}
                    onPress={stopAndSendRecording}
                  >
                    <MaterialCommunityIcons name="send" size={20} color="#FFF" />
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity
                    style={styles.attachButton}
                    onPress={handlePickAttachment}
                    disabled={isPicking || isSending}
                  >
                    <MaterialCommunityIcons name="paperclip" size={22} color="#FF8C42" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.attachButton}
                    onPress={handleLaunchCamera}
                    disabled={isPicking || isSending}
                  >
                    <MaterialCommunityIcons name="camera" size={22} color="#FF8C42" />
                  </TouchableOpacity>
                  <TextInput
                    style={styles.input}
                    placeholder="Message..."
                    placeholderTextColor="#666"
                    value={inputText}
                    onChangeText={setInputText}
                    multiline
                    editable={!isSending}
                  />
                  {inputText.trim() ? (
                    <TouchableOpacity
                      style={[styles.sendButton, styles.sendButtonActive]}
                      onPress={handleSendMessage}
                      disabled={isSending}
                    >
                      {isSending ? (
                        <ActivityIndicator size="small" color="#FFF" />
                      ) : (
                        <MaterialCommunityIcons name="send" size={20} color="#FFF" />
                      )}
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[styles.sendButton, styles.sendButtonActive, { backgroundColor: '#FF8C42' }]}
                      onPress={startRecording}
                      disabled={isSending}
                    >
                      <MaterialCommunityIcons name="microphone" size={22} color="#FFF" />
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
        </View>

      {/* Image Preview Modal */}
      <Modal visible={previewImage !== null} transparent={true} onRequestClose={() => setPreviewImage(null)}>
        <View style={styles.modalBackground}>
          <TouchableOpacity style={styles.modalCloseButton} onPress={() => setPreviewImage(null)}>
            <MaterialCommunityIcons name="close" size={32} color="#FFF" />
          </TouchableOpacity>
          {previewImage && (
            <Image
              source={{ uri: previewImage }}
              style={styles.modalImage}
              contentFit="contain"
            />
          )}
        </View>
      </Modal>
    </KeyboardAvoidingView>
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
    backgroundColor: '#000000',
  },
  inputSafeArea: {},
  messageList: {
    paddingVertical: 12,
    paddingBottom: 16,
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
    marginTop: 4,
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
  attachButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 2,
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
  imageAttachment: {
    width: 220,
    height: 150,
    borderRadius: 8,
    marginBottom: 4,
    backgroundColor: '#050505',
  },
  cancelRecordButton: {
    padding: 10,
    marginRight: 4,
  },
  recordingIndicator: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#FF3B30',
    marginRight: 8,
  },
  recordingText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '600',
  },
  audioContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 8,
    width: 220,
    marginBottom: 4,
  },
  audioPlayButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1A1A1A',
    justifyContent: 'center',
    alignItems: 'center',
  },
  audioWaveformContainer: {
    flex: 1,
    marginLeft: 8,
  },
  audioText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  audioTrack: {
    height: 3,
    backgroundColor: '#222',
    borderRadius: 1.5,
    width: '100%',
    overflow: 'hidden',
  },
  audioFill: {
    height: '100%',
    backgroundColor: '#FF8C42',
  },
  videoContainer: {
    width: 220,
    height: 120,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
    marginBottom: 4,
  },
  videoPlaceholder: {
    flex: 1,
    backgroundColor: '#262626',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 12,
  },
  videoText: {
    color: '#CCC',
    fontSize: 11,
    marginTop: 8,
    width: '90%',
    textAlign: 'center',
  },
  videoPlayOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0A0A0A',
    borderRadius: 8,
    padding: 8,
    width: 220,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: '#333',
    gap: 8,
  },
  fileText: {
    color: '#FFF',
    fontSize: 12,
    flex: 1,
  },
  modalBackground: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCloseButton: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 50 : 20,
    right: 20,
    zIndex: 10,
  },
  modalImage: {
    width: '90%',
    height: '80%',
  },
});
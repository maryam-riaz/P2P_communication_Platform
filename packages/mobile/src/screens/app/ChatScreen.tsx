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
  KeyboardAvoidingView,
  Keyboard,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { Q } from '@nozbe/watermelondb';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Audio, Video, ResizeMode } from 'expo-av';
import { Image } from 'expo-image';
import { database } from '../../db';
import { Message as MessageModel } from '../../db/models';
import { messageRouter } from '../../p2p';
import { meshTransport } from '../../nearby';
import { sendImage } from '../../p2p/ImageSender';
import { subscribeChunkProgress, subscribeImageComplete } from '../../p2p/ChunkAssembler';
import { logm, errm } from '../../utils/logger';

const TAG = 'CHAT';

interface Attachment {
  uri: string;
  type: 'image' | 'video' | 'audio';
  name: string;
}

interface DisplayMessage {
  id: string;
  senderId: 'user' | 'other';
  text: string;
  timestamp: string;
  status: string;
  attachment?: Attachment;
}

let msgCounter = 0;

function generateId(): string {
  msgCounter++;
  return `msg_${Date.now()}_${msgCounter}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatScreen({ route, navigation }: any) {
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

  const conversationId: string = route?.params?.conversationId || '';
  const endpointId: string = route?.params?.endpointId || '';
  const peerId: string = route?.params?.peerId || endpointId;
  const recipientName: string = route?.params?.recipientName || 'Chat';

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [transferProgress, setTransferProgress] = useState<{ [msgId: string]: number }>({});
  const [isPeerActive, setIsPeerActive] = useState(false);
  const [displayName, setDisplayName] = useState(recipientName);
  const flatListRef = useRef<FlatList>(null);

  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [audioProgress, setAudioProgress] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordingInterval = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (soundRef.current) { soundRef.current.unloadAsync().catch(() => {}); }
      if (recordingRef.current) { recordingRef.current.stopAndUnloadAsync().catch(() => {}); }
      clearInterval(recordingInterval.current);
    };
  }, []);

  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewVideo, setPreviewVideo] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      const parent = navigation.getParent();
      parent?.setOptions({ tabBarStyle: { display: 'none' } });
      return () => parent?.setOptions({ tabBarStyle: undefined });
    }, [navigation])
  );

  // ─── Load messages from DB ────────────────────────────────────────────────

  useEffect(() => {
    if (!conversationId) return;

    const load = async () => {
      try {
        const records = await database.get<MessageModel>('messages')
          .query(
            Q.where('conversation_id', conversationId),
            Q.sortBy('created_at', 'asc'),
          )
          .fetch();

        const display: DisplayMessage[] = records.map((r) => ({
          id: r.id,
          senderId: r.senderId === messageRouter.getDeviceId() ? 'user' : 'other',
          text: r.type === 'image' ? '' : r.payload,
          timestamp: r.createdAt ? formatTime(r.createdAt.getTime()) : '',
          status: r.status,
          attachment: r.type === 'image' ? { uri: r.payload, type: 'image', name: 'Image' } : undefined,
        }));

        setMessages(display);
      } catch (err) {
        errm(TAG, 'Failed to load messages', err);
      }
    };

    load();

    const subscription = database.get<MessageModel>('messages')
      .query(
        Q.where('conversation_id', conversationId),
        Q.sortBy('created_at', 'asc'),
      )
      .observe();

    const sub = subscription.subscribe((records) => {
      const display: DisplayMessage[] = records.map((r) => ({
        id: r.id,
        senderId: r.senderId === messageRouter.getDeviceId() ? 'user' : 'other',
        text: r.type === 'image' ? '' : r.payload,
        timestamp: r.createdAt ? formatTime(r.createdAt.getTime()) : '',
        status: r.status,
        attachment: r.type === 'image' ? { uri: r.payload, type: 'image', name: 'Image' } : undefined,
      }));
      setMessages(display);
    });

    return () => sub.unsubscribe();
  }, [conversationId]);

  // ─── Subscribe to PeerSession for reactive displayName ────────────────────

  useEffect(() => {
    const unsub = messageRouter.subscribePeerSession((session) => {
      if ((session.fingerprint === peerId || session.endpointId === endpointId) && session.displayName) {
        setDisplayName(session.displayName);
      }
    });
    return unsub;
  }, [peerId, endpointId]);

  // ─── Subscribe to incoming decrypted messages ─────────────────────────────

  useEffect(() => {
    const unsub = messageRouter.subscribeDecrypted(
      (senderId: string, plaintext: string, msgConversationId?: string) => {
        if (msgConversationId && msgConversationId !== conversationId) return;
        logm(TAG, `Decrypted message from ${senderId}: ${plaintext.substring(0, 40)}`);
      },
    );

    return () => unsub();
  }, [conversationId]);

  // ─── Subscribe to chunk progress ──────────────────────────────────────────

  useEffect(() => {
    const completedRecords = new Set<string>();

    const unsubProgress = subscribeChunkProgress((recordId, received, total) => {
      const pct = Math.round((received / total) * 100);
      setTransferProgress((prev) => ({ ...prev, [recordId]: pct }));
    });

    const unsubComplete = subscribeImageComplete(async (recordId, localUri, messageId) => {
      if (completedRecords.has(recordId)) return;
      completedRecords.add(recordId);

      logm(TAG, `Image reassembled: ${recordId} → ${localUri}`);

      try {
        const existing = await database.get<MessageModel>('messages')
          .query(
            Q.where('conversation_id', conversationId),
            Q.where('type', 'image'),
            Q.where('payload', localUri),
          )
          .fetch();

        if (existing.length > 0) {
          logm(TAG, `Image ${recordId} already persisted, skipping`);
          return;
        }

        await database.write(async () => {
          await database.get<MessageModel>('messages').create((msg) => {
            msg.senderId = peerId;
            msg.receiverId = messageRouter.getDeviceId();
            msg.conversationId = conversationId;
            msg.type = 'image';
            msg.payload = localUri;
            msg.nonce = '';
            msg.ttl = 4;
            msg.status = 'received';
          });
        });

        await messageRouter.updateConversationPreview(conversationId, '📷 Image', 'image');
      } catch (err) {
        errm(TAG, 'Failed to persist received image', err);
      }

      setTransferProgress((prev) => {
        const next = { ...prev };
        delete next[recordId];
        return next;
      });
    });

    return () => {
      unsubProgress();
      unsubComplete();
    };
  }, [conversationId, peerId]);

  // ─── Check peer connectivity ──────────────────────────────────────────────

  useEffect(() => {
    const check = async () => {
      try {
        const connected = await meshTransport.getConnectedPeers();
        setIsPeerActive(connected.some((p: any) => p.endpointId === endpointId));
      } catch { setIsPeerActive(false); }
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [endpointId]);

  // ─── Mark conversation read on focus ───────────────────────────────────

  useFocusEffect(
    useCallback(() => {
      if (conversationId && peerId) {
        messageRouter.markConversationRead(conversationId, peerId);
      }
    }, [conversationId, peerId]),
  );

  // ─── Send text message ────────────────────────────────────────────────────

  const handleSendMessage = async () => {
    if (!inputText.trim() || !endpointId || isSending) return;
    const text = inputText.trim();
    setInputText('');
    setIsSending(true);

    try {
      const resolvedEndpointId = messageRouter.resolveEndpointId(endpointId);
      if (!resolvedEndpointId) {
        logm(TAG, 'No valid endpointId for peer, message queued');
        return;
      }
      await messageRouter.ensureConversation(conversationId, peerId, recipientName);

      await messageRouter.sendToPeer(resolvedEndpointId, 'TEXT', text, { conversationId });
      logm(TAG, 'Message sent successfully');
    } catch (err) {
      errm(TAG, 'Failed to send message', err);
    } finally {
      setIsSending(false);
    }
  };

  // ─── Send image ───────────────────────────────────────────────────────────

  const sendImageMessage = async (imageUri: string, imageName: string) => {
    if (!endpointId) return;

    setIsSending(true);
    await messageRouter.ensureConversation(conversationId, peerId, recipientName);

    const mimeType = imageName.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

    await sendImage(endpointId, imageUri, imageName, conversationId, mimeType, (sent, total) => {
      const pct = Math.round((sent / total) * 100);
      setTransferProgress((prev) => ({ ...prev, ['img_sending']: pct }));
    });

    setIsSending(false);
    setTimeout(() => {
      setTransferProgress((prev) => {
        const next = { ...prev };
        delete next['img_sending'];
        return next;
      });
    }, 500);
  };
  // ─── Attachment picker ────────────────────────────────────────────────────

  const handlePickAttachment = async () => {
    if (isPicking || isSending) return;
    setIsPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
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

      if (type === 'image') {
        await sendImageMessage(asset.uri, asset.name || `image-${Date.now()}.jpg`);
      } else {
        const newMsg: DisplayMessage = {
          id: generateId(),
          senderId: 'user',
          text: '',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: 'sent',
          attachment: { uri: asset.uri, type, name: asset.name || `doc-${Date.now()}` },
        };
        setMessages((prev) => [...prev, newMsg]);
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      }
    } catch (err) {
      console.error('[ChatScreen] Attachment processing failed:', err);
    } finally {
      setIsPicking(false);
      setIsSending(false);
    }
  };

  // ─── Camera capture ───────────────────────────────────────────────────────

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
    try {
      const cameraPermission = await ImagePicker.requestCameraPermissionsAsync();
      if (cameraPermission.status !== 'granted') {
        Alert.alert('Permission Denied', 'Camera permission is required to capture media.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Settings', onPress: () => Linking.openSettings() }
        ]);
        return;
      }
      if (mode === 'video') {
        const microPermission = await Audio.requestPermissionsAsync();
        if (microPermission.status !== 'granted') {
          Alert.alert('Permission Denied', 'Microphone permission is required to record videos.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Settings', onPress: () => Linking.openSettings() }
          ]);
          return;
        }
      }
      setIsPicking(true);
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: mode === 'video' ? ['videos'] : ['images'],
        quality: 0.4,
        videoMaxDuration: 15,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) {
        setIsPicking(false);
        return;
      }
      const asset = result.assets[0];
      const assetType = asset.type === 'video' ? 'video' : 'image';

      if (assetType === 'image') {
        const extension = 'jpg';
        const name = asset.fileName || `camera-${Date.now()}.${extension}`;
        await sendImageMessage(asset.uri, name);
      } else {
        setIsSending(true);
        const name = asset.fileName || `camera-${Date.now()}.mp4`;
        const newMsg: DisplayMessage = {
          id: generateId(),
          senderId: 'user',
          text: '',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: 'sent',
          attachment: { uri: asset.uri, type: 'video', name },
        };
        setMessages((prev) => [...prev, newMsg]);
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      }
    } catch (err) {
      console.error('[ChatScreen] Camera capture processing failed:', err);
    } finally {
      setIsPicking(false);
      setIsSending(false);
    }
  };

  // ─── Voice recording ──────────────────────────────────────────────────────

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
    clearInterval(recordingInterval.current);
    const recording = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    setRecordingDuration(0);
    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (!uri) return;
      setIsSending(true);
      const fileName = `voice-note-${Date.now()}.m4a`;
      const newMsg: DisplayMessage = {
        id: generateId(),
        senderId: 'user',
        text: '',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: 'sent',
        attachment: { uri, type: 'audio', name: fileName },
      };
      setMessages((prev) => [...prev, newMsg]);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
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
      await recording.stopAndUnloadAsync();
    } catch (err) {
      console.warn('[Audio Recorder] Cancel cleanup failed:', err);
    }
  };

  // ─── Audio playback ───────────────────────────────────────────────────────

  const toggleAudioPlayback = async (msgId: string, audioUri: string) => {
    try {
      if (playingAudioId === msgId) {
        if (soundRef.current) {
          await soundRef.current.pauseAsync();
          setPlayingAudioId(null);
        }
      } else {
        if (soundRef.current) {
          try {
            await soundRef.current.stopAsync();
            await soundRef.current.unloadAsync();
          } catch (e) { }
          soundRef.current = null;
        }

        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
        });
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

  // ─── Progress bar rendering ───────────────────────────────────────────────

  const renderProgressBar = (progress: number | undefined) => {
    if (progress === undefined) return null;
    return (
      <View style={styles.progressContainer}>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
        </View>
        <Text style={styles.progressText}>{progress}%</Text>
      </View>
    );
  };

  // ─── Attachment rendering ─────────────────────────────────────────────────

  const renderAttachment = (attachment: Attachment, msgId: string, status: string) => {
    const progress = transferProgress[msgId];
    const isDownloaded = attachment.uri !== '' && !attachment.uri.startsWith('file:///') === false;

    if (attachment.type === 'image') {
      if (progress !== undefined) {
        return (
          <View style={[styles.imageAttachment, { backgroundColor: '#262626', justifyContent: 'center', alignItems: 'center', borderRadius: 8, padding: 12 }]}>
            <MaterialCommunityIcons name="image-outline" size={32} color="#666" />
            {status === 'failed' ? (
              <Text style={{ color: '#FF3B30', fontSize: 11, marginTop: 4, textAlign: 'center' }}>Failed to send</Text>
            ) : (
              renderProgressBar(progress)
            )}
          </View>
        );
      }

      return (
        <TouchableOpacity onPress={() => setPreviewImage(attachment.uri)}>
          <View style={{ position: 'relative' }}>
            <Image
              source={{ uri: attachment.uri }}
              style={styles.imageAttachment}
              contentFit="cover"
            />
            {progress !== undefined && (
              <View style={styles.progressOverlay}>
                {renderProgressBar(progress)}
              </View>
            )}
          </View>
        </TouchableOpacity>
      );
    }

    if (attachment.type === 'audio') {
      const isCurrentPlaying = playingAudioId === msgId;
      return (
        <View style={styles.audioContainer}>
          <TouchableOpacity
            style={styles.audioPlayButton}
            onPress={() => isDownloaded && toggleAudioPlayback(msgId, attachment.uri)}
            disabled={!isDownloaded || progress !== undefined}
          >
            <MaterialCommunityIcons
              name={!isDownloaded ? 'cloud-download-outline' : isCurrentPlaying ? 'pause' : 'play'}
              size={24}
              color="#FF8C42"
            />
          </TouchableOpacity>
          <View style={styles.audioWaveformContainer}>
            <Text style={styles.audioText} numberOfLines={1}>
              🎵 {attachment.name}
            </Text>
            {!isDownloaded ? (
              status === 'failed' ? (
                <Text style={{ color: '#FF3B30', fontSize: 11 }}>Download failed</Text>
              ) : (
                renderProgressBar(progress ?? 0)
              )
            ) : (
              <View style={styles.audioTrack}>
                <View
                  style={[
                    styles.audioFill,
                    { width: `${isCurrentPlaying ? audioProgress : 0}%` },
                  ]}
                />
              </View>
            )}
          </View>
        </View>
      );
    }

    if (attachment.type === 'video') {
      if (progress !== undefined) {
        return (
          <View style={[styles.videoContainer, styles.videoPlaceholder]}>
            <MaterialCommunityIcons name="video-off-outline" size={32} color="#666" />
            <Text style={[styles.videoText, { color: status === 'failed' ? '#FF3B30' : '#CCC' }]} numberOfLines={1}>
              {status === 'failed' ? 'Failed to send video' : 'Sending video...'}
            </Text>
            {status !== 'failed' && renderProgressBar(progress ?? 0)}
          </View>
        );
      }

      return (
        <TouchableOpacity
          style={styles.videoContainer}
          onPress={() => progress === undefined && setPreviewVideo(attachment.uri)}
          activeOpacity={0.8}
        >
          <View style={styles.videoPlaceholder}>
            <MaterialCommunityIcons name="video" size={32} color="#FFF" />
            <Text style={styles.videoText} numberOfLines={1}>
              🎥 {attachment.name}
            </Text>
            {progress !== undefined && renderProgressBar(progress)}
          </View>
          {progress === undefined && (
            <View style={styles.videoPlayOverlay} pointerEvents="none">
              <MaterialCommunityIcons name="play-circle-outline" size={48} color="#FF8C42" />
            </View>
          )}
        </TouchableOpacity>
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

  // ─── Message bubble rendering ─────────────────────────────────────────────

  const renderMessageItem = ({ item }: { item: DisplayMessage }) => {
    const isUser = item.senderId === 'user';
    return (
      <View style={[styles.messageContainer, isUser && styles.userMessageContainer]}>
        <View style={[styles.messageBubble, isUser && styles.userMessageBubble]}>
          {item.attachment && renderAttachment(item.attachment, item.id, item.status)}
          {item.text.trim() !== '' && (
            <Text style={[styles.messageText, isUser && styles.userMessageText]}>
              {item.text}
            </Text>
          )}
          <View style={styles.messageFooter}>
            <Text style={[styles.timestamp, isUser && styles.userTimestamp]}>
              {item.timestamp}
            </Text>
            {isUser ? (
              <MaterialCommunityIcons
                name={
                  item.status === 'read'
                    ? 'check-all'
                    : item.status === 'sent'
                      ? 'check'
                      : item.status === 'failed'
                        ? 'alert-circle'
                        : 'clock-outline'
                }
                size={12}
                color={item.status === 'read' ? '#02C39A' : item.status === 'failed' ? '#FF3B30' : '#999'}
                style={{ marginLeft: 4 }}
              />
            ) : (
              <>
                {item.status === 'downloading' && (
                  <ActivityIndicator size="small" color="#FF8C42" style={{ marginLeft: 6, transform: [{ scale: 0.8 }] }} />
                )}
                {item.status === 'failed' && (
                  <MaterialCommunityIcons
                    name="alert-circle-outline"
                    size={14}
                    color="#FF3B30"
                    style={{ marginLeft: 4 }}
                  />
                )}
              </>
            )}
          </View>
        </View>
      </View>
    );
  };

  // ─── UI ───────────────────────────────────────────────────────────────────

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

      {/* Video Player Modal */}
      <Modal
        visible={previewVideo !== null}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setPreviewVideo(null)}
      >
        <View style={styles.modalBackground}>
          <TouchableOpacity style={styles.modalCloseButton} onPress={() => setPreviewVideo(null)}>
            <MaterialCommunityIcons name="close" size={32} color="#FFF" />
          </TouchableOpacity>
          {previewVideo && (
            <Video
              source={{ uri: previewVideo }}
              style={styles.modalVideo}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
              isLooping={false}
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
  modalVideo: {
    width: '100%',
    height: '70%',
  },
  modalImage: {
    width: '90%',
    height: '80%',
  },
  progressContainer: {
    width: '100%',
    marginTop: 6,
    alignItems: 'center',
  },
  progressTrack: {
    height: 4,
    backgroundColor: '#333',
    borderRadius: 2,
    width: '100%',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#FF8C42',
  },
  progressText: {
    color: '#FF8C42',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 4,
  },
  progressOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
    borderRadius: 8,
  },
});

import { Database, Q } from '@nozbe/watermelondb';
import uuid from 'react-native-uuid';
import { sha256 } from 'js-sha256';
import { NativeModules } from 'react-native';
import { MobileRepository } from '../db/repository';
import { Message, LocalUser, KnownPeer } from '../db/models';
import { SecureTransport } from '../comms/secure-transport';
import { BehaviorSubject, Observable, from, map, switchMap, distinctUntilChanged } from 'rxjs';


export interface Conversation {
  recipientId: string;
  recipientName: string;
  lastMessage: string;
  lastTimestamp: number;
  unreadCount: number;
  syncStatus: string;
}

export class ChatService {
  private repository: MobileRepository;
  // Map of active secure transports keyed by remote peer device ID
  private activeTransports = new Map<string, SecureTransport>();
  private activeTransportsSubject = new BehaviorSubject<string[]>([]);
  private transportLastSeenMap = new Map<string, number>();
  private heartbeatIntervalId: any = null;
  private secureTransportsList: SecureTransport[] = [];
  private transportHandshakeStartMap = new Map<SecureTransport, number>();
  private consecutivePingFailures = new Map<string, number>();

  private incomingFileTransfers = new Map<string, {
    metadata: {
      senderId: string;
      recipientId: string;
      fileName: string;
      fileType: 'image' | 'video' | 'audio';
      totalChunks: number;
      timestamp: number;
    };
    chunks: string[];
    tempFilePath: string; // Native temp path for incremental writes
    chunksReceived: number;
  }>();

  private pendingPlaceholderWrites = new Map<string, Promise<any>>();

  private transferProgressSubject = new BehaviorSubject<{ [messageId: string]: number }>({});

  constructor(private db: Database) {
    this.repository = new MobileRepository(db);
    this.startHeartbeatTimer();
  }

  observeTransferProgress(): Observable<{ [messageId: string]: number }> {
    return this.transferProgressSubject.asObservable();
  }

  private updateTransferProgress(messageId: string, progress: number) {
    console.log(`[ChatService] updateTransferProgress for ${messageId.substring(0, 8)}: ${progress}%`);
    const current = { ...this.transferProgressSubject.value };
    current[messageId] = progress;
    this.transferProgressSubject.next(current);
  }

  private clearTransferProgress(messageId: string) {
    console.log(`[ChatService] clearTransferProgress for ${messageId.substring(0, 8)}`);
    const current = { ...this.transferProgressSubject.value };
    delete current[messageId];
    this.transferProgressSubject.next(current);
  }


  registerSecureTransport(transport: SecureTransport) {
    if (!this.secureTransportsList.includes(transport)) {
      this.secureTransportsList.push(transport);
      console.log('[ChatService] SecureTransport registered. Current pool size:', this.secureTransportsList.length);
    }
  }

  unregisterSecureTransport(transport: SecureTransport) {
    this.secureTransportsList = this.secureTransportsList.filter(t => t !== transport);
    this.transportHandshakeStartMap.delete(transport);
    console.log('[ChatService] SecureTransport unregistered. Current pool size:', this.secureTransportsList.length);
  }

  private startHeartbeatTimer() {
    this.heartbeatIntervalId = setInterval(async () => {
      const now = Date.now();
      const myUser = await this.repository.getLocalUser();
      const myDeviceId = myUser ? (myUser._raw as any).device_id : 'unknown';

      // ── Self-Healing: Trigger handshake retry for connected raw channels without handshake ──
      for (const transport of this.secureTransportsList) {
        if (transport.isConnected() && !transport.isHandshakeComplete()) {
          if (!this.transportHandshakeStartMap.has(transport)) {
            this.transportHandshakeStartMap.set(transport, now);
          } else {
            const startTime = this.transportHandshakeStartMap.get(transport)!;
            // If the raw transport is connected but handshake fails to complete for > 30 seconds, disconnect and prune it
            if (now - startTime > 30000) {
              console.log('[ChatService] Secure transport handshake timeout (>30s). Disconnecting stale raw transport.');
              this.transportHandshakeStartMap.delete(transport);
              try {
                await transport.disconnect();
              } catch (err) {
                console.warn('[ChatService] Error disconnecting timed-out transport:', err);
              }
              continue;
            }
          }
          console.log('[ChatService] Self-Healing: Connected raw transport found without active handshake. Triggering handshake retry...');
          try {
            await transport.establishHandshake();
          } catch (err) {
            console.warn('[ChatService] Self-healing handshake retry failed:', err);
          }
        } else {
          this.transportHandshakeStartMap.delete(transport);
        }
      }

      for (const [peerId, transport] of Array.from(this.activeTransports.entries())) {
        const lastSeen = this.transportLastSeenMap.get(peerId) || 0;
        const timeSinceLastSeen = now - lastSeen;
        
        // If no data received for 15 seconds, attempt a handshake retry to revive the connection
        // or fully prune the transport if silent for more than 25 seconds
        if (timeSinceLastSeen > 15000 && timeSinceLastSeen <= 25000) {
          console.log(`[ChatService] Peer ${peerId} inactive/silent (>15s). Attempting handshake retry to revive connection...`);
          try {
            await transport.establishHandshake();
          } catch (err) {
            console.warn(`[ChatService] Failed establishing handshake to revive silent peer ${peerId}:`, err);
          }
        } else if (timeSinceLastSeen > 25000) {
          console.log(`[ChatService] Peer ${peerId} silent for more than 25s. Pruning transport.`);
          this.consecutivePingFailures.delete(peerId);
          
          // Mark in-progress incoming file transfers from this peer as failed in the DB
          for (const [msgId, transfer] of Array.from(this.incomingFileTransfers.entries())) {
            if (transfer.metadata.senderId === peerId) {
              this.incomingFileTransfers.delete(msgId);
              this.clearTransferProgress(msgId);
              this.db.get<Message>('messages').find(msgId).then(msg => {
                this.db.write(async () => {
                  await msg.update(record => {
                    record.localSyncStatus = 'failed';
                  });
                });
              }).catch(() => {});
            }
          }

          try {
            await transport.disconnect();
          } catch (err) {
            console.warn('[ChatService] Error disconnecting silent transport:', err);
          }
          this.unregisterActiveTransport(peerId);
        } else {
          // Send keep-alive ping
          try {
            const pingPayload = {
              type: 'ping',
              senderId: myDeviceId,
              timestamp: now
            };
            await transport.send(JSON.stringify(pingPayload));
            // Reset consecutive failures on successful send
            this.consecutivePingFailures.set(peerId, 0);
          } catch (err) {
            console.warn(`[ChatService] Failed sending heartbeat ping to ${peerId}:`, err);
            const failures = (this.consecutivePingFailures.get(peerId) || 0) + 1;
            this.consecutivePingFailures.set(peerId, failures);
            // If 3 consecutive pings fail, the socket is likely dead - disconnect immediately
            if (failures >= 3) {
              console.log(`[ChatService] ${peerId}: 3 consecutive ping failures. Socket appears dead. Disconnecting immediately.`);
              this.consecutivePingFailures.delete(peerId);
              try {
                await transport.disconnect();
              } catch (e) {
                console.warn('[ChatService] Error disconnecting after ping failures:', e);
              }
              this.unregisterActiveTransport(peerId);
            }
          }
        }
      }
    }, 10000); // Check every 10 seconds
  }

  registerActiveTransport(peerId: string, transport: SecureTransport) {
    this.activeTransports.set(peerId, transport);
    this.transportLastSeenMap.set(peerId, Date.now());
    this.activeTransportsSubject.next(Array.from(this.activeTransports.keys()));
    // When transport is established, trigger retry of pending messages for this peer
    this.retryPendingMessages(peerId);
  }

  unregisterActiveTransport(peerId: string) {
    this.activeTransports.delete(peerId);
    this.transportLastSeenMap.delete(peerId);
    this.consecutivePingFailures.delete(peerId);
    this.activeTransportsSubject.next(Array.from(this.activeTransports.keys()));
  }

  updateTransportActivity(peerId: string) {
    this.transportLastSeenMap.set(peerId, Date.now());
  }

  /**
   * Stops the heartbeat timer. Call this when the service is being torn down
   * (e.g., user logs out or app goes to background).
   */
  destroy() {
    if (this.heartbeatIntervalId !== null) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
      console.log('[ChatService] Heartbeat timer stopped.');
    }
  }

  observeActiveTransportIds(): Observable<string[]> {
    return this.activeTransportsSubject.asObservable().pipe(
      distinctUntilChanged((prev, curr) => {
        if (prev.length !== curr.length) return false;
        return prev.every((id, i) => id === curr[i]);
      })
    );
  }

  getActiveTransport(peerId: string): SecureTransport | undefined {
    return this.activeTransports.get(peerId);
  }

  getOutboundTransport(recipientId: string): SecureTransport | undefined {
    let transport = this.getActiveTransport(recipientId);
    if (transport) return transport;

    // Fallback: if we are a client in a group and have exactly 1 active transport,
    // that transport is our Group Owner/hub. Route all outbound traffic through it.
    if (this.activeTransports.size === 1) {
      return Array.from(this.activeTransports.values())[0];
    }
    return undefined;
  }

  getAllActiveTransports(): Map<string, SecureTransport> {
    return this.activeTransports;
  }
  
  /**
   * Observes all messages in a specific conversation, sorted chronologically.
   * Filters to messages (local → remote) OR (remote → local) only.
   * @param recipientId The remote peer's device ID
   * @param localDeviceId This device's own device ID (to filter outbound messages correctly)
   */
  observeMessagesByRecipient(recipientId: string, localDeviceId: string): Observable<Message[]> {
    return this.db.get<Message>('messages')
      .query(
        Q.or(
          // Outbound: I sent to them
          Q.and(
            Q.where('sender_id', localDeviceId),
            Q.where('recipient_id', recipientId)
          ),
          // Inbound: They sent to me
          Q.and(
            Q.where('sender_id', recipientId),
            Q.where('recipient_id', localDeviceId)
          )
        ),
        Q.sortBy('created_at', Q.desc),
        Q.take(50)
      )
      .observeWithColumns(['sync_status']);
  }

  private cachedLocalDeviceId: string | null = null;

  private async getLocalDeviceId(): Promise<string> {
    if (this.cachedLocalDeviceId) return this.cachedLocalDeviceId;
    const localUser = await this.repository.getLocalUser();
    if (localUser) {
      this.cachedLocalDeviceId = (localUser._raw as any).device_id;
      return this.cachedLocalDeviceId || 'unknown';
    }
    return 'unknown';
  }

  /**
   * Observes all messages and groups them into unique conversations with names and unread counts.
   */
  observeConversations(): Observable<Conversation[]> {
    return this.db.get<Message>('messages').query(Q.sortBy('created_at', Q.desc), Q.take(100)).observeWithColumns(['sync_status']).pipe(
      switchMap((messages) =>
        from(
          (async () => {
            // Retrieve cached device ID to avoid database queries
            const myDeviceId = await this.getLocalDeviceId();

            const conversationsMap = new Map<string, { lastMsg: Message; unread: number }>();

            for (const msg of messages) {
              const rawMsg = msg._raw as any;
              // Conversation partner is either the sender or the recipient depending on who is remote
              const partnerId = rawMsg.recipient_id && rawMsg.recipient_id !== '' && rawMsg.sender_id === myDeviceId
                ? rawMsg.recipient_id
                : rawMsg.sender_id;

              if (!partnerId || partnerId === myDeviceId) continue;

              const existing = conversationsMap.get(partnerId);
              if (!existing) {
                conversationsMap.set(partnerId, {
                  lastMsg: msg,
                  unread: rawMsg.sync_status === 'delivered' && rawMsg.sender_id === partnerId ? 1 : 0
                });
              } else {
                if (rawMsg.sync_status === 'delivered' && rawMsg.sender_id === partnerId) {
                  existing.unread++;
                }
              }
            }

            // Optimize query: Fetch only peers that are actually involved in the active conversations
            const partnerIds = Array.from(conversationsMap.keys());
            const peers = partnerIds.length > 0
              ? await this.db.get<KnownPeer>('known_peers').query(Q.where('device_id', Q.oneOf(partnerIds))).fetch()
              : [];

            const convos: Conversation[] = [];
            conversationsMap.forEach((val, partnerId) => {
              const peer = peers.find(p => (p._raw as any).device_id === partnerId);
              const rawLast = val.lastMsg._raw as any;
              let lastMsgText = rawLast.ciphertext || '';

              if (lastMsgText.startsWith('{') && lastMsgText.endsWith('}')) {
                try {
                  const parsed = JSON.parse(lastMsgText);
                  if (parsed.attachment) {
                    if (parsed.attachment.type === 'image') {
                      lastMsgText = '📷 Photo';
                    } else if (parsed.attachment.type === 'video') {
                      lastMsgText = '🎥 Video';
                    } else if (parsed.attachment.type === 'audio') {
                      lastMsgText = '🎵 Audio Note';
                    } else {
                      lastMsgText = '📁 Attachment';
                    }
                  } else {
                    lastMsgText = parsed.text || '';
                  }
                } catch (e) {
                  // Fallback
                }
              }

              convos.push({
                recipientId: partnerId,
                recipientName: peer ? (peer._raw as any).display_name || partnerId.slice(0, 8) : partnerId.slice(0, 8),
                lastMessage: lastMsgText,
                lastTimestamp: rawLast.created_at,
                unreadCount: val.unread,
                syncStatus: rawLast.sync_status
              });
            });

            return convos.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
          })()
        )
      ),
      distinctUntilChanged((prev, curr) => {
        if (prev.length !== curr.length) return false;
        return prev.every((p, i) => 
          p.recipientId === curr[i].recipientId &&
          p.recipientName === curr[i].recipientName &&
          p.lastMessage === curr[i].lastMessage &&
          p.lastTimestamp === curr[i].lastTimestamp &&
          p.unreadCount === curr[i].unreadCount &&
          p.syncStatus === curr[i].syncStatus
        );
      })
    ) as any;
  }

  /**
   * Mark all messages in a conversation as read.
   */
  async markAsRead(recipientId: string): Promise<void> {
    const unreadMessages = await this.db.get<Message>('messages')
      .query(
        Q.where('sender_id', recipientId),
        Q.where('sync_status', 'delivered')
      ).fetch();

    if (unreadMessages.length === 0) return;

    await this.db.write(async () => {
      await Promise.all(unreadMessages.map(msg => 
        msg.update(record => {
          record.localSyncStatus = 'read';
        })
      ));
    });
  }

  /**
   * Sends a message to a recipient. Writes to local DB optimistically as 'pending',
   * and attempts to transmit over SecureTransport if connected.
   */
  async sendMessage(
    text: string, 
    recipientId: string, 
    attachment?: { uri: string; type: 'image' | 'video' | 'audio'; name: string }
  ): Promise<Message> {
    const localUser = await this.repository.getLocalUser();
    if (!localUser) throw new Error('No local user profile logged in');

    const messageId = uuid.v4() as string;
    const timestamp = Date.now();
    const myDeviceId = (localUser._raw as any).device_id as string;

    const messageBody = attachment 
      ? JSON.stringify({ text, attachment })
      : text;

    // Hash is keyed on (messageId + senderId + timestamp_number) for stable deduplication
    const contentHash = sha256(messageId + myDeviceId + timestamp);

    // 1. Write optimistically to Database
    const message = await this.repository.addNewMessage({
      id: messageId,
      senderId: myDeviceId,
      recipientId,
      ciphertext: messageBody, // Store serialized payload
      signature: '',
      contentHash,
      hopCount: 1,
      ttl: 16,
      originDeviceId: myDeviceId,
      syncStatus: 'pending',
      createdAt: timestamp
    });

    // 2. Perform transmission asynchronously in the background.
    // Do not await this to allow immediate render of the message on the local chat screen.
    this.transmitMessageInBackground(message, text, recipientId, attachment).catch(err => {
      console.warn('[ChatService] Background transmission failed:', err);
    });

    return message;
  }

  /**
   * Transmits a message in the background. If the message has an attachment,
   * it sends it in chunks to avoid blocking the single-threaded JS execution loop.
   */
  private async transmitMessageInBackground(
    message: Message,
    text: string,
    recipientId: string,
    attachment?: { uri: string; type: 'image' | 'video' | 'audio'; name: string }
  ): Promise<void> {
    let secureTransport = this.getOutboundTransport(recipientId);

    // Self-healing: check for unhandshaked connection
    if (!secureTransport) {
      const unhandshakedConn = this.secureTransportsList.find(t => t.isConnected() && !t.isHandshakeComplete());
      if (unhandshakedConn) {
        console.log(`[ChatService] Outbox activity triggered self-healing handshake for recipient ${recipientId}`);
        unhandshakedConn.establishHandshake().catch(err => {
          console.warn('[ChatService] Failed to establish handshake during sendMessage self-healing:', err);
        });
      }
    }

    if (secureTransport && secureTransport.isConnected() && secureTransport.isHandshakeComplete()) {
      try {
        const localUser = await this.repository.getLocalUser();
        const myDeviceId = localUser ? (localUser._raw as any).device_id : 'unknown';

        if (attachment) {
          const rawTransport = secureTransport.getRawTransport();

          const fileSize = await NativeModules.WifiDirect.getFileSize(attachment.uri);
          const chunkSize = 1048572;
          const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));
          const timestamp = message.createdAt;

          this.updateTransferProgress(message.id, 0);

          await secureTransport.send(JSON.stringify({
            type: 'chat_file_start',
            messageId: message.id,
            senderId: myDeviceId,
            recipientId,
            fileName: attachment.name,
            fileType: attachment.type,
            totalChunks,
            timestamp,
          }));

          for (let i = 0; i < totalChunks; i++) {
            const offset = i * chunkSize;
            const length = Math.min(chunkSize, fileSize - offset);
            const chunkData = await NativeModules.WifiDirect.readChunkAsBase64(attachment.uri, offset, length);
            const chunkEnvelope = JSON.stringify({
              type: 'chat_file_chunk',
              messageId: message.id,
              senderId: myDeviceId,
              recipientId,
              chunkIndex: i,
              totalChunks,
              chunkData,
            }) + '\n';
            await rawTransport.send(new TextEncoder().encode(chunkEnvelope));
            this.updateTransferProgress(message.id, Math.round(((i + 1) / totalChunks) * 100));
            // Yield to event loop to prevent JS thread starvation during large transfers
            await new Promise(r => setTimeout(r, 40));
          }

          // 3. Send end marker via SecureTransport (encrypted + signed)
          await secureTransport.send(JSON.stringify({
            type: 'chat_file_end',
            messageId: message.id,
            senderId: myDeviceId,
            recipientId
          }));

          this.clearTransferProgress(message.id);
        } else {
          // Send regular text message
          const payload = {
            id: message.id,
            senderId: myDeviceId,
            recipientId,
            text,
            timestamp: message.createdAt,
            type: 'chat'
          };
          await secureTransport.send(JSON.stringify(payload));
        }

        // Update database status to 'sent'
        await this.db.write(async () => {
          await message.update(record => {
            record.localSyncStatus = 'sent';
          });
        });
      } catch (error) {
        console.warn(`Failed transmission to ${recipientId}, message remains pending.`, error);
      }
    } else {
      console.log(`Peer ${recipientId} offline or not handshaked. Message stored in outbox queue.`);
    }
  }

  async handleIncomingFilePayload(payload: any): Promise<void> {
    const { type, messageId } = payload;
    if (type === 'chat_file_start') {
      const { senderId, recipientId, fileName, fileType, totalChunks, timestamp } = payload;
      // Create a unique temp file path on native side for incremental writes
      let tempFilePath = '';
      try {
        tempFilePath = await NativeModules.WifiDirect.createTempFilePath(messageId.substring(0, 8));
      } catch {
        tempFilePath = '';
      }
      this.incomingFileTransfers.set(messageId, {
        metadata: { senderId, recipientId, fileName, fileType, totalChunks, timestamp },
        chunks: [],
        tempFilePath,
        chunksReceived: 0,
      });
      this.updateTransferProgress(messageId, 0);

      const placeholderPromise = (async () => {
        try {
          const contentHash = sha256(messageId + senderId + timestamp);
          const exists = await this.repository.getMessageByHash(contentHash);
          if (!exists) {
            const body = JSON.stringify({
              text: '',
              attachment: {
                uri: '',
                type: fileType,
                name: fileName,
              },
            });
            await this.repository.addNewMessage({
              id: messageId,
              senderId,
              recipientId,
              ciphertext: body,
              signature: '',
              contentHash,
              hopCount: 1,
              ttl: 16,
              originDeviceId: senderId,
              syncStatus: 'downloading',
              createdAt: Date.now(),
            });
          }
        } catch (err) {
          console.warn('[ChatService] Failed to create database placeholder:', err);
        }
      })();
      this.pendingPlaceholderWrites.set(messageId, placeholderPromise);
    } else if (type === 'chat_file_chunk') {
      const { chunkIndex, chunkData } = payload;
      const transfer = this.incomingFileTransfers.get(messageId);
      if (transfer) {
        // Write chunk directly to native temp file — avoids holding the
        // entire file payload in JS memory (prevents bridge OOM).
        if (transfer.tempFilePath) {
          try {
            await NativeModules.WifiDirect.tcpAppendChunk(chunkData, transfer.tempFilePath);
          } catch (err) {
            console.warn(`[ChatService] Failed to append chunk ${chunkIndex} to temp file:`, err);
          }
        }
        transfer.chunksReceived++;
        const progress = Math.round((transfer.chunksReceived / transfer.metadata.totalChunks) * 100);
        this.updateTransferProgress(messageId, progress);
      }
    } else if (type === 'chat_file_end') {
      const transfer = this.incomingFileTransfers.get(messageId);
      if (transfer) {
        this.incomingFileTransfers.delete(messageId);
        this.clearTransferProgress(messageId);

        const pendingWrite = this.pendingPlaceholderWrites.get(messageId);
        if (pendingWrite) {
          await pendingWrite;
          this.pendingPlaceholderWrites.delete(messageId);
        }

        // Finalize the temp file to its proper name
        let localUri = '';
        if (transfer.tempFilePath) {
          try {
            localUri = await NativeModules.WifiDirect.tcpFinalizeFile(
              transfer.tempFilePath,
              transfer.metadata.fileName,
            );
          } catch (err) {
            console.warn('[ChatService] Failed to finalize file:', err);
          }
        }
        if (!localUri) {
          console.error('[ChatService] No valid local URI after file transfer — file may be lost.');
          return;
        }

        try {
          const msg = await this.db.get<Message>('messages').find(messageId);
          const body = JSON.stringify({
            text: '',
            attachment: {
              uri: localUri,
              type: transfer.metadata.fileType,
              name: transfer.metadata.fileName,
            },
          });
          await this.db.write(async () => {
            await msg.update((record) => {
              record.ciphertext = body;
              record.localSyncStatus = 'delivered';
            });
          });
        } catch {
          const chatPayload = {
            id: messageId,
            senderId: transfer.metadata.senderId,
            recipientId: transfer.metadata.recipientId,
            text: '',
            attachmentMeta: {
              uri: localUri,
              type: transfer.metadata.fileType,
              name: transfer.metadata.fileName,
            },
            timestamp: transfer.metadata.timestamp,
          };
          await this.handleIncomingMessage(chatPayload);
        }

        await this.sendDeliveryAck(messageId, transfer.metadata.senderId);
      }
    }
  }

  /**
   * Processes incoming message JSON from SecureTransport callback.
   * Performs deduplication and writes to local database.
   */
  async handleIncomingMessage(payload: any): Promise<void> {
    const { id, senderId, recipientId, text, timestamp } = payload;
    // Use the same hash scheme as sendMessage: (id + senderId + timestamp_number)
    const tsNum = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    const contentHash = sha256(id + senderId + tsNum);
    console.log(`[ChatService] handleIncomingMessage check: id=${id}, senderId=${senderId}, recipientId=${recipientId}, contentHash=${contentHash}`);

    // Duplicate message check
    const existing = await this.repository.getMessageByHash(contentHash);
    if (existing) {
      console.log(`Duplicate message ${id} received. Dropped.`);
      // The sender may have re-sent this because our original ack never
      // arrived (connection dropped mid-flight, etc). Re-send the ack so
      // their copy isn't stuck showing as undelivered forever.
      await this.sendDeliveryAck(id, senderId);
      return;
    }

    // If payload contains attachment metadata, reconstruct the JSON ciphertext
    // so the local receiver's toDisplayMessage can parse and display it.
    const ciphertextBody = payload.attachmentMeta
      ? JSON.stringify({ text: payload.text, attachment: payload.attachmentMeta })
      : payload.text;

    // Write message to DB
    const saved = await this.repository.addNewMessage({
      id,
      senderId,
      recipientId: recipientId || '',
      ciphertext: ciphertextBody,
      signature: '',
      contentHash,
      hopCount: 1,
      ttl: 16,
      originDeviceId: senderId,
      syncStatus: 'delivered',
      createdAt: Date.now()
    });
    console.log(`[ChatService] Successfully written incoming message to DB. ID: ${saved.id}, Sender: ${senderId}`);

    // Let the original sender know their message actually arrived, so their
    // copy of it can move from 'sent' to 'delivered'.
    await this.sendDeliveryAck(id, senderId);
  }

  /**
   * Sends a small 'ack' packet back to the peer that sent us a message,
   * confirming it was received and written to our database. Mirrors the
   * existing ping/pong heartbeat pattern already used on this transport.
   */
  private async sendDeliveryAck(messageId: string, originalSenderId: string): Promise<void> {
    const transport = this.getOutboundTransport(originalSenderId);
    if (!transport || !transport.isHandshakeComplete()) {
      // No live connection back to them right now — nothing to do. If they
      // reconnect and retry the message (see retryPendingMessages), our
      // duplicate-check path above will re-send the ack at that point.
      return;
    }
    try {
      const ackPayload = { type: 'ack', messageId, senderId: originalSenderId };
      await transport.send(JSON.stringify(ackPayload));
    } catch (err) {
      console.warn(`[ChatService] Failed to send delivery ack for message ${messageId}:`, err);
    }
  }

  /**
   * Called when an 'ack' packet is received for a message we sent. Advances
   * that message's own local status from 'sent' to 'delivered' so the UI
   * tick can update, WhatsApp-style.
   */
  async markMessageDelivered(messageId: string): Promise<void> {
    const msg = await this.db.get<Message>('messages').find(messageId).catch(() => null);
    if (!msg) {
      console.warn(`[ChatService] Received ack for unknown message ${messageId}`);
      return;
    }
    const rawMsg = msg._raw as any;
    // Don't downgrade a message that's already progressed further (e.g. 'read').
    if (rawMsg.sync_status === 'read' || rawMsg.sync_status === 'delivered') return;

    await this.db.write(async () => {
      await msg.update(record => {
        record.localSyncStatus = 'delivered';
      });
    });
    console.log(`[ChatService] Message ${messageId} marked as delivered.`);
  }

  /**
   * Retries transmission of pending or un-acked outbound messages to the peer.
   *
   * Covers two cases:
   *  - 'pending': the transmit itself never succeeded (peer was offline).
   *  - 'sent': the transmit succeeded, but the delivery ack never came back
   *    (e.g. the connection dropped right after send() but before the ack
   *    arrived), so this device has no way to know the peer actually got it.
   *
   * Re-sending a 'sent' message here is safe: the receiver's duplicate check
   * in handleIncomingMessage() will recognize the repeat by content hash and
   * just re-send the ack rather than writing a second copy of the message.
   */
  private async retryPendingMessages(peerId: string): Promise<void> {
    const pending = await this.db.get<Message>('messages')
      .query(
        Q.where('recipient_id', peerId),
        Q.or(
          Q.where('sync_status', 'pending'),
          Q.where('sync_status', 'sent')
        ),
        Q.take(20)
      ).fetch();

    if (pending.length === 0) return;

    const secureTransport = this.getActiveTransport(peerId);
    if (!secureTransport || !secureTransport.isHandshakeComplete()) return;

    console.log(`[ChatService] Retrying ${pending.length} pending/un-acked messages for peer ${peerId}`);
    
    for (const msg of pending) {
      const rawMsg = msg._raw as any;
      try {
        let text = rawMsg.ciphertext || '';
        let attachment: any = undefined;
        if (text.startsWith('{') && text.endsWith('}')) {
          try {
            const parsed = JSON.parse(text);
            text = parsed.text || '';
            attachment = parsed.attachment;
          } catch (e) {}
        }
        
        this.transmitMessageInBackground(msg, text, peerId, attachment).catch(err => {
          console.warn(`Retry failed for message ${msg.id}`, err);
        });
      } catch (err) {
        console.warn(`Retry parsing failed for message ${msg.id}`, err);
      }
    }
  }
}
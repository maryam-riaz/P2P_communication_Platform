import { Database, Q } from '@nozbe/watermelondb';
import uuid from 'react-native-uuid';
import { sha256 } from 'js-sha256';
import { MobileRepository } from '../db/repository';
import { Message, LocalUser, KnownPeer } from '../db/models';
import { SecureTransport } from '../comms/secure-transport';
import { BehaviorSubject, Observable, from, map, switchMap } from 'rxjs';


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

  constructor(private db: Database) {
    this.repository = new MobileRepository(db);
    this.startHeartbeatTimer();
  }

  private startHeartbeatTimer() {
    this.heartbeatIntervalId = setInterval(async () => {
      const now = Date.now();
      const myUser = await this.repository.getLocalUser();
      const myDeviceId = myUser ? (myUser._raw as any).device_id : 'unknown';

      for (const [peerId, transport] of Array.from(this.activeTransports.entries())) {
        const lastSeen = this.transportLastSeenMap.get(peerId) || 0;
        
        // If no data received for 25 seconds, assume peer went out of range or disconnected silently
        if (now - lastSeen > 25000) {
          console.log(`[ChatService] Peer ${peerId} silent for more than 25s. Pruning transport.`);
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
          } catch (err) {
            console.warn(`[ChatService] Failed sending heartbeat ping to ${peerId}:`, err);
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
    return this.activeTransportsSubject.asObservable();
  }

  getActiveTransport(peerId: string): SecureTransport | undefined {
    return this.activeTransports.get(peerId);
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
        Q.sortBy('created_at', Q.asc)
      )
      .observe();
  }

  /**
   * Observes all messages and groups them into unique conversations with names and unread counts.
   */
  observeConversations(): Observable<Conversation[]> {
    return this.db.get<Message>('messages').query(Q.sortBy('created_at', Q.desc)).observe().pipe(
      switchMap((messages) =>
        from(
          (async () => {
            // Fetch local user and peers asynchronously (LokiJS does not support fetchSync)
            const localUsers = await this.db.get<LocalUser>('local_user').query().fetch();
            const myDeviceId = (localUsers[0]?._raw as any)?.device_id as string | undefined;
            const peers = await this.db.get<KnownPeer>('known_peers').query().fetch();

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

            const convos: Conversation[] = [];
            conversationsMap.forEach((val, partnerId) => {
              const peer = peers.find(p => (p._raw as any).device_id === partnerId);
              const rawLast = val.lastMsg._raw as any;

              convos.push({
                recipientId: partnerId,
                recipientName: peer ? (peer._raw as any).display_name || partnerId.slice(0, 8) : partnerId.slice(0, 8),
                lastMessage: rawLast.ciphertext || '',
                lastTimestamp: rawLast.created_at,
                unreadCount: val.unread,
                syncStatus: rawLast.sync_status
              });
            });

            return convos.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
          })()
        )
      )
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
      for (const msg of unreadMessages) {
        await msg.update(record => {
          record.localSyncStatus = 'read';
        });
      }
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

    // 2. Attempt transmission if peer is active
    const secureTransport = this.getActiveTransport(recipientId);
    if (secureTransport && secureTransport.isHandshakeComplete()) {
      try {
        const payload = {
          id: messageId,
          senderId: myDeviceId,
          recipientId,
          text: messageBody,
          timestamp, // send as numeric ms since epoch — receiver uses same value for hash
          type: 'chat'
        };
        await secureTransport.send(JSON.stringify(payload));

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
      console.log(`Peer ${recipientId} offline. Message stored in outbox queue.`);
    }

    return message;
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
      return;
    }

    // Write message to DB
    const saved = await this.repository.addNewMessage({
      id,
      senderId,
      recipientId: recipientId || '',
      ciphertext: text,
      signature: '',
      contentHash,
      hopCount: 1,
      ttl: 16,
      originDeviceId: senderId,
      syncStatus: 'delivered',
      createdAt: Date.now()
    });
    console.log(`[ChatService] Successfully written incoming message to DB. ID: ${saved.id}, Sender: ${senderId}`);
  }

  /**
   * Retries transmission of any pending outbound messages to the peer.
   */
  private async retryPendingMessages(peerId: string): Promise<void> {
    const pending = await this.db.get<Message>('messages')
      .query(
        Q.where('recipient_id', peerId),
        Q.where('sync_status', 'pending')
      ).fetch();

    if (pending.length === 0) return;

    const secureTransport = this.getActiveTransport(peerId);
    if (!secureTransport || !secureTransport.isHandshakeComplete()) return;

    console.log(`[ChatService] Retrying ${pending.length} pending messages for peer ${peerId}`);
    
    for (const msg of pending) {
      const rawMsg = msg._raw as any;
      try {
        const payload = {
          id: msg.id,
          senderId: rawMsg.sender_id,
          recipientId: peerId,
          text: rawMsg.ciphertext,
          timestamp: new Date(rawMsg.created_at).toISOString(),
          type: 'chat'
        };
        await secureTransport.send(JSON.stringify(payload));
        
        await this.db.write(async () => {
          await msg.update(record => {
            record.localSyncStatus = 'sent';
          });
        });
      } catch (err) {
        console.warn(`Retry failed for message ${msg.id}`, err);
      }
    }
  }
}

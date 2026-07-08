import { Database, Q } from '@nozbe/watermelondb';
import uuid from 'react-native-uuid';
import { sha256 } from 'js-sha256';
import { MobileRepository } from '../db/repository';
import { Message, LocalUser, KnownPeer } from '../db/models';
import { SecureTransport } from '../comms/secure-transport';
import { Observable, from, map, switchMap } from 'rxjs';


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

  constructor(private db: Database) {
    this.repository = new MobileRepository(db);
  }

  registerActiveTransport(peerId: string, transport: SecureTransport) {
    this.activeTransports.set(peerId, transport);
    // When transport is established, trigger retry of pending messages for this peer
    this.retryPendingMessages(peerId);
  }

  unregisterActiveTransport(peerId: string) {
    this.activeTransports.delete(peerId);
  }

  getActiveTransport(peerId: string): SecureTransport | undefined {
    return this.activeTransports.get(peerId);
  }

  /**
   * Observes all messages to a specific recipient, sorted chronologically.
   */
  observeMessagesByRecipient(recipientId: string): Observable<Message[]> {
    const localUserQuery = this.db.get<LocalUser>('local_user').query();
    
    // Return messages where (sender = local and recipient = remote) OR (sender = remote and recipient = local)
    return this.db.get<Message>('messages')
      .query(
        Q.or(
          Q.and(Q.where('sender_id', recipientId)),
          Q.and(Q.where('recipient_id', recipientId))
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
            const myDeviceId = localUsers[0]?._raw?.device_id as string | undefined;
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
          record._raw.sync_status = 'read';
        });
      }
    });
  }

  /**
   * Sends a message to a recipient. Writes to local DB optimistically as 'pending',
   * and attempts to transmit over SecureTransport if connected.
   */
  async sendMessage(text: string, recipientId: string): Promise<Message> {
    const localUser = await this.repository.getLocalUser();
    if (!localUser) throw new Error('No local user profile logged in');

    const messageId = uuid.v4() as string;
    const timestamp = Date.now();
    const myDeviceId = localUser._raw.device_id as string;

    // 1. Write optimistically to Database
    const message = await this.repository.addNewMessage({
      id: messageId,
      senderId: myDeviceId,
      recipientId,
      ciphertext: text, // Plaintext is stored locally for UI rendering
      signature: '',
      contentHash: sha256(text + timestamp + messageId),
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
          text,
          timestamp: new Date(timestamp).toISOString(),
          type: 'chat'
        };
        await secureTransport.send(JSON.stringify(payload));

        // Update database status to 'sent'
        await this.db.write(async () => {
          await message.update(record => {
            record._raw.sync_status = 'sent';
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
    const contentHash = sha256(text + timestamp + id);

    // Duplicate message check
    const existing = await this.repository.getMessageByHash(contentHash);
    if (existing) {
      console.log(`Duplicate message ${id} received. Dropped.`);
      return;
    }

    // Write message to DB
    await this.repository.addNewMessage({
      id,
      senderId,
      recipientId: recipientId || '',
      ciphertext: text,
      signature: '',
      contentHash,
      hopCount: 1,
      ttl: 16,
      originDeviceId: senderId,
      syncStatus: 'delivered', // received is marked delivered initially
      createdAt: new Date(timestamp).getTime()
    });
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
            record._raw.sync_status = 'sent';
          });
        });
      } catch (err) {
        console.warn(`Retry failed for message ${msg.id}`, err);
      }
    }
  }
}

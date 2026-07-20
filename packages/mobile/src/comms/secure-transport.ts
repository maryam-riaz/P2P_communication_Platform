import { PeerTransport } from './transport';
import { 
  EncryptedPacket, 
  encryptAndSign, 
  verifyAndDecrypt 
} from 'shared';
import { logger } from '../utils/logger';

// ─── RN-safe helpers (no Buffer / Node globals) ───────────────────────────────

/** Encode a UTF-8 string → Uint8Array */
function strToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Decode a Uint8Array → UTF-8 string */
function bytesToStr(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Encode a Uint8Array → base64 string */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a base64 string → Uint8Array */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────

export class SecureTransport {
  private remotePublicKeyHex: string | null = null;
  private remoteDeviceId: string | null = null;
  private remoteDisplayName: string | null = null;
  private handshakeCompleted = false;
  private onMessageCallback: ((plaintext: string) => void) | null = null;
  private handshakeCallbacks: (() => void)[] = [];
  private rxBuffer = '';
  private lastHandshakeSentTime = 0;

  constructor(
    private rawTransport: PeerTransport,
    private localPrivateKeyHex: string,
    private localPublicKeyHex: string,
    private localDeviceId: string,
    private localDisplayName: string
  ) {
    // Register listeners on the underlying transport
    this.rawTransport.receive((data) => this.handleRawReceivedData(data));
  }

  /**
   * Performs the initial cryptographic key exchange handshake.
   * Sends the local public key unencrypted over the active P2P connection.
   */
  async establishHandshake(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHandshakeSentTime < 3000) {
      logger.sec.debug('Handshake request rate-limited (cooldown active)');
      return;
    }
    this.lastHandshakeSentTime = now;
    logger.sec.info('Initiating P2P public key exchange');
    const keyMsg = `PUBKEY_EXCHANGE:${this.localPublicKeyHex}:${this.localDeviceId}:${this.localDisplayName}\n`;
    await this.rawTransport.send(strToBytes(keyMsg));
  }

  /**
   * Registers a callback triggered when a decrypted plaintext message is received.
   */
  receive(callback: (plaintext: string) => void): void {
    this.onMessageCallback = callback;
  }

  /**
   * Returns the underlying raw transport so callers can send unencrypted bytes
   * directly (e.g., large file chunks where AES overhead is prohibitive).
   */
  getRawTransport(): PeerTransport {
    return this.rawTransport;
  }

  /**
   * Registers a callback triggered when the key exchange completes and the secure channel is ready.
   */
  onHandshakeReady(callback: () => void): void {
    if (this.handshakeCompleted) {
      callback();
    } else {
      this.handshakeCallbacks.push(callback);
    }
  }

  /**
   * Encrypts, signs, and sends a plaintext message to the remote peer.
   * Uses AES-256-GCM encryption and ECDSA digital signatures (CRYPTO.md).
   * Returns a promise that resolves when the payload is written to the socket.
   */
  async send(plaintext: string, skipSignature = false): Promise<void> {
    if (!this.handshakeCompleted || !this.remotePublicKeyHex) {
      throw new Error('[Secure Transport] Cannot send: handshake not yet complete.');
    }
    const packet = encryptAndSign(
      strToBytes(plaintext),
      this.localPrivateKeyHex,
      this.localPublicKeyHex,
      this.remotePublicKeyHex,
      skipSignature
    );
    const serialized = JSON.stringify({
      payload:            bytesToBase64(packet.payload),
      iv:                 bytesToBase64(packet.iv),
      tag:                bytesToBase64(packet.tag),
      signature:          bytesToBase64(packet.signature),
      sender_public_key:  bytesToBase64(packet.sender_public_key),
      content_hash:       bytesToBase64(packet.content_hash),
      skip_sig:           skipSignature,
    }) + '\n';
    await this.rawTransport.send(strToBytes(serialized));
  }

  private static readonly MAX_BUFFER_SIZE = 8 * 1024 * 1024; // 8 MB

  private handleRawReceivedData(data: Uint8Array): void {
    const chunkStr = bytesToStr(data);
    this.rxBuffer += chunkStr;

    // Guard against runaway buffer growth (e.g. large attachment without newline terminator)
    if (this.rxBuffer.length > SecureTransport.MAX_BUFFER_SIZE) {
      logger.sec.error('rxBuffer exceeded 8MB limit, clearing to prevent OOM');
      this.rxBuffer = '';
      return;
    }

    let newlineIndex: number;
    while ((newlineIndex = this.rxBuffer.indexOf('\n')) !== -1) {
      const line = this.rxBuffer.substring(0, newlineIndex);
      this.rxBuffer = this.rxBuffer.substring(newlineIndex + 1);

      if (line.trim() !== '') {
        this.processPacket(line);
      }
    }
  }

  private processPacket(rawStr: string): void {
    // Case 1: Handshake identity exchange (unencrypted)
    if (rawStr.startsWith('PUBKEY_EXCHANGE:')) {
      const parts = rawStr.split(':');
      this.remotePublicKeyHex = parts[1]?.trim() || null;
      this.remoteDeviceId = parts[2]?.trim() || null;
      this.remoteDisplayName = parts[3]?.trim() || null;
      this.handshakeCompleted = true;
      logger.sec.info('Handshake complete', { remoteId: this.remoteDeviceId, displayName: this.remoteDisplayName });

      // Respond by triggering our own handshake key exchange (will be rate-limited by 3s cooldown if we just sent one)
      this.establishHandshake().catch((err) => {
        logger.sec.warn('Failed replying to public key exchange', { error: String(err) });
      });

      // Trigger all pending handshake ready callbacks
      this.handshakeCallbacks.forEach((cb) => cb());
      return;
    }

    // Case 2: Raw (unencrypted) file chunk — sent directly via rawTransport for speed.
    // Detected by the plain JSON 'type' field without an encryption envelope.
    if (rawStr.startsWith('{"type":"chat_file_chunk"')) {
      if (this.onMessageCallback) {
        this.onMessageCallback(rawStr);
      }
      return;
    }

    // Case 3: Encrypted JSON packet
    if (!this.handshakeCompleted) {
      logger.sec.warn('Received data before identity exchange completed, packet dropped');
      return;
    }

    try {
      // Deserialise the JSON envelope and convert every base64 field back to Uint8Array
      const envelope = JSON.parse(rawStr) as {
        payload: string;
        iv: string;
        tag: string;
        signature: string;
        sender_public_key: string;
        content_hash: string;
        skip_sig?: boolean;
      };

      const packet: EncryptedPacket = {
        payload:           base64ToBytes(envelope.payload),
        iv:                base64ToBytes(envelope.iv),
        tag:               base64ToBytes(envelope.tag),
        signature:         base64ToBytes(envelope.signature),
        sender_public_key: base64ToBytes(envelope.sender_public_key),
        content_hash:      base64ToBytes(envelope.content_hash),
      };

      // Verify ECDSA signature and decrypt with AES-256-GCM
      const plaintextBytes = verifyAndDecrypt(packet, this.localPrivateKeyHex, envelope.skip_sig);
      const plaintext = bytesToStr(plaintextBytes);

      if (this.onMessageCallback) {
        this.onMessageCallback(plaintext);
      }
    } catch (error) {
      logger.sec.error('Error decrypting or verifying signature', { error: String(error) });
    }
  }

  isHandshakeComplete(): boolean {
    return this.handshakeCompleted;
  }

  isConnected(): boolean {
    return this.rawTransport.isConnected();
  }

  getRemotePublicKey(): string | null {
    return this.remotePublicKeyHex;
  }

  getRemoteDeviceId(): string | null {
    return this.remoteDeviceId;
  }

  getRemoteDisplayName(): string | null {
    return this.remoteDisplayName;
  }

  async disconnect(): Promise<void> {
    this.handshakeCompleted = false;
    this.remotePublicKeyHex = null;
    this.remoteDeviceId = null;
    this.remoteDisplayName = null;
    await this.rawTransport.disconnect();
  }
}

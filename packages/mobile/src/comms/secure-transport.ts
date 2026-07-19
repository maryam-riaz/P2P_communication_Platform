import { PeerTransport } from './transport';
import { 
  EncryptedPacket, 
  encryptAndSign, 
  verifyAndDecrypt 
} from 'shared';

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

/**
 * A pre-allocated byte accumulator that avoids string concatenation overhead
 * and binary-data corruption from TextDecoder round-trips.
 * Grows in 8KB pages and supports scanning for a delimiter byte (0x0A = \n).
 */
class ByteBuffer {
  private buffer: Uint8Array;
  private length = 0;
  private static readonly PAGE_SIZE = 8192;

  constructor() {
    this.buffer = new Uint8Array(ByteBuffer.PAGE_SIZE);
  }

  /** Append raw bytes. Grows the underlying buffer in page-sized chunks. */
  append(data: Uint8Array): void {
    const needed = this.length + data.length;
    if (needed > this.buffer.length) {
      const newSize = Math.ceil(needed / ByteBuffer.PAGE_SIZE) * ByteBuffer.PAGE_SIZE;
      const newBuf = new Uint8Array(newSize);
      newBuf.set(this.buffer.subarray(0, this.length));
      this.buffer = newBuf;
    }
    this.buffer.set(data, this.length);
    this.length += data.length;
  }

  /** Number of bytes currently in the buffer. */
  get size(): number {
    return this.length;
  }

  /**
   * Extracts and removes a complete line (bytes up to first newline).
   * Returns the line as bytes WITHOUT the trailing \n, or null if no \n found.
   */
  readLine(): Uint8Array | null {
    const idx = this.indexOfNewline();
    if (idx === -1) return null;
    const line = this.buffer.slice(0, idx);
    // Shift remaining data left (removing up to and including the \n)
    const remaining = this.length - idx - 1;
    if (remaining > 0) {
      this.buffer.copyWithin(0, idx + 1, this.length);
    }
    this.length = remaining;
    return line;
  }

  private indexOfNewline(): number {
    for (let i = 0; i < this.length; i++) {
      if (this.buffer[i] === 0x0a) return i;
    }
    return -1;
  }

  /** Truncate buffer to 0 (used on overflow). */
  clear(): void {
    this.length = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class SecureTransport {
  private remotePublicKeyHex: string | null = null;
  private remoteDeviceId: string | null = null;
  private remoteDisplayName: string | null = null;
  private handshakeCompleted = false;
  private onMessageCallback: ((plaintext: string) => void) | null = null;
  private handshakeCallbacks: (() => void)[] = [];
  private rxBuffer = new ByteBuffer();
  private lastHandshakeSentTime = 0;
  private handshakeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeAttempts = 0;
  private disposed = false;
  private handshakeRetryStartTime = 0;

  constructor(
    private rawTransport: PeerTransport,
    private localPrivateKeyHex: string,
    private localPublicKeyHex: string,
    private localDeviceId: string,
    private localDisplayName: string
  ) {
    // Register listeners on the underlying transport
    this.rawTransport.receive((data) => this.handleRawReceivedData(data));
    this.rawTransport.onDisconnect(() => {
      this.disposed = true;
      this.clearHandshakeRetryTimer();
    });
  }

  /**
   * Performs the initial cryptographic key exchange handshake.
   * Sends the local public key unencrypted over the active P2P connection.
   * A forced reply is allowed when we just received a remote exchange so the
   * peer can complete the handshake even if the cooldown would otherwise block it.
   */
  async establishHandshake(force = false): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (!force && this.handshakeCompleted) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastHandshakeSentTime < 3000) {
      console.log('[Secure Transport] Handshake request rate-limited (cooldown active).');
      return;
    }

    this.lastHandshakeSentTime = now;
    this.handshakeAttempts += 1;
    console.log(`[Secure Transport] Initiating unencrypted P2P public key exchange (attempt ${this.handshakeAttempts})...`);
    const keyMsg = `PUBKEY_EXCHANGE:${this.localPublicKeyHex}:${this.localDeviceId}:${this.localDisplayName}\n`;

    try {
      await this.rawTransport.send(strToBytes(keyMsg));
    } catch (err) {
      console.warn('[Secure Transport] Handshake send failed; retrying once the transport is ready:', err);
      this.scheduleHandshakeRetry();
      return;
    }

    if (!this.handshakeCompleted) {
      this.scheduleHandshakeRetry();
    }
  }

  private scheduleHandshakeRetry(): void {
    if (this.disposed || this.handshakeCompleted || this.handshakeRetryTimer) {
      return;
    }

    if (this.handshakeRetryStartTime === 0) {
      this.handshakeRetryStartTime = Date.now();
    } else if (Date.now() - this.handshakeRetryStartTime > 15000) {
      // Handshake has been retrying for more than 15s without success.
      // The underlying connection is likely dead (half-open TCP socket).
      // Disconnect to trigger cleanup and reconnection.
      console.warn('[Secure Transport] Handshake retry timed out after 15s. Disconnecting dead transport.');
      this.handshakeRetryStartTime = 0;
      this.rawTransport.disconnect().catch(() => {});
      return;
    }

    this.handshakeRetryTimer = setTimeout(() => {
      this.handshakeRetryTimer = null;
      if (!this.disposed && !this.handshakeCompleted) {
        this.establishHandshake(true).catch((err) => {
          console.warn('[Secure Transport] Handshake retry failed:', err);
        });
      }
    }, 2000);
  }

  private clearHandshakeRetryTimer(): void {
    this.handshakeRetryStartTime = 0;
    if (this.handshakeRetryTimer) {
      clearTimeout(this.handshakeRetryTimer);
      this.handshakeRetryTimer = null;
    }
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

  private static readonly MAX_BUFFER_BYTES = 8 * 1024 * 1024; // 8 MB

  private handleRawReceivedData(data: Uint8Array): void {
    this.rxBuffer.append(data);

    // Guard against runaway buffer growth (e.g. large attachment without newline terminator)
    if (this.rxBuffer.size > SecureTransport.MAX_BUFFER_BYTES) {
      console.error('[Secure Transport] rxBuffer exceeded 8MB limit. Clearing buffer to prevent OOM.');
      this.rxBuffer.clear();
      return;
    }

    let line: Uint8Array | null;
    while ((line = this.rxBuffer.readLine()) !== null) {
      if (line.length > 0) {
        this.processPacket(line);
      }
    }
  }

  private processPacket(rawBytes: Uint8Array): void {
    // Fast path: decode only for the first few bytes to detect message type.
    // Avoid full decode for binary-heavy packets.
    const firstBytes = bytesToStr(rawBytes.subarray(0, 64));

    // Case 1: Handshake identity exchange (unencrypted)
    if (firstBytes.startsWith('PUBKEY_EXCHANGE:')) {
      const rawStr = bytesToStr(rawBytes);
      const match = rawStr.match(/^PUBKEY_EXCHANGE:([^:]+):([^:]+):(.*)$/);
      if (match) {
        this.remotePublicKeyHex = match[1]?.trim() || null;
        this.remoteDeviceId = match[2]?.trim() || null;
        this.remoteDisplayName = match[3]?.trim() || null;
      } else {
        const parts = rawStr.split(':');
        this.remotePublicKeyHex = parts[1]?.trim() || null;
        this.remoteDeviceId = parts[2]?.trim() || null;
        this.remoteDisplayName = parts[3]?.trim() || null;
      }
      this.handshakeCompleted = true;
      this.clearHandshakeRetryTimer();
      console.log(`[Secure Transport] Handshake complete! Received remote ID: ${this.remoteDeviceId}, display name: ${this.remoteDisplayName}`);

      this.establishHandshake(true).catch((err) => {
        console.warn('[Secure Transport] Failed replying to public key exchange:', err);
      });

      this.handshakeCallbacks.forEach((cb) => cb());
      return;
    }

    // Case 2: Raw (unencrypted) file chunk — sent directly via rawTransport for speed.
    // Detected by the plain JSON 'type' field without an encryption envelope.
    if (firstBytes.startsWith('{"type":"chat_file_chunk"')) {
      if (this.onMessageCallback) {
        this.onMessageCallback(bytesToStr(rawBytes));
      }
      return;
    }

    // Case 3: Encrypted JSON packet
    if (!this.handshakeCompleted) {
      console.warn('[Secure Transport] Received data before identity exchange completed. Packet dropped.');
      return;
    }

    try {
      const rawStr = bytesToStr(rawBytes);
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

      const plaintextBytes = verifyAndDecrypt(packet, this.localPrivateKeyHex, envelope.skip_sig);
      const plaintext = bytesToStr(plaintextBytes);

      if (this.onMessageCallback) {
        this.onMessageCallback(plaintext);
      }
    } catch (error) {
      console.error('[Secure Transport] Error decrypting or verifying digital signature:', error);
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
    this.clearHandshakeRetryTimer();
    this.handshakeCompleted = false;
    this.remotePublicKeyHex = null;
    this.remoteDeviceId = null;
    this.remoteDisplayName = null;
    await this.rawTransport.disconnect();
  }
}

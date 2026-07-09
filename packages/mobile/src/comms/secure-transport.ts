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

// ─────────────────────────────────────────────────────────────────────────────

export class SecureTransport {
  private remotePublicKeyHex: string | null = null;
  private handshakeCompleted = false;
  private onMessageCallback: ((plaintext: string) => void) | null = null;
  private handshakeCallbacks: (() => void)[] = [];

  constructor(
    private rawTransport: PeerTransport,
    private localPrivateKeyHex: string,
    private localPublicKeyHex: string
  ) {
    // Register listeners on the underlying transport
    this.rawTransport.receive((data) => this.handleRawReceivedData(data));
  }

  /**
   * Performs the initial cryptographic key exchange handshake.
   * Sends the local public key unencrypted over the active P2P connection.
   */
  async establishHandshake(): Promise<void> {
    console.log('[Secure Transport] Initiating unencrypted P2P public key exchange...');
    const keyMsg = `PUBKEY_EXCHANGE:${this.localPublicKeyHex}`;
    await this.rawTransport.send(strToBytes(keyMsg));
  }

  /**
   * Registers a callback triggered when a decrypted plaintext message is received.
   */
  receive(callback: (plaintext: string) => void): void {
    this.onMessageCallback = callback;
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
   * Returns a promise that resolves when the payload is written to the socket.
   */
  async send(plaintext: string): Promise<void> {
    if (!this.handshakeCompleted || !this.remotePublicKeyHex) {
      throw new Error('Cryptographic handshake not completed yet');
    }

    const plaintextBytes = strToBytes(plaintext);

    // Encrypt and sign the payload using ECDH P-256 and AES-256-GCM
    const packet: EncryptedPacket = encryptAndSign(
      plaintextBytes,
      this.localPrivateKeyHex,
      this.localPublicKeyHex,
      this.remotePublicKeyHex
    );

    // Serialize packet to JSON (all binary fields as base64) and send as bytes
    const serialized = JSON.stringify({
      payload:           bytesToBase64(packet.payload),
      iv:                bytesToBase64(packet.iv),
      tag:               bytesToBase64(packet.tag),
      signature:         bytesToBase64(packet.signature),
      sender_public_key: bytesToBase64(packet.sender_public_key),
      content_hash:      bytesToBase64(packet.content_hash),
    });

    await this.rawTransport.send(strToBytes(serialized));
  }

  private handleRawReceivedData(data: Uint8Array): void {
    const rawStr = bytesToStr(data);

    // Case 1: Handshake key exchange
    if (rawStr.startsWith('PUBKEY_EXCHANGE:')) {
      const parts = rawStr.split(':');
      this.remotePublicKeyHex = parts[1];
      this.handshakeCompleted = true;
      console.log(`[Secure Transport] Handshake complete! Received remote public key: ${this.remotePublicKeyHex.substring(0, 16)}...`);

      // Trigger all pending handshake ready callbacks
      this.handshakeCallbacks.forEach((cb) => cb());
      this.handshakeCallbacks = [];
      return;
    }

    // Case 2: Standard encrypted message packet
    if (!this.handshakeCompleted) {
      console.warn('[Secure Transport] Received data before cryptographic handshake completed. Packet dropped.');
      return;
    }

    try {
      const parsed = JSON.parse(rawStr);
      const packet: EncryptedPacket = {
        payload:           base64ToBytes(parsed.payload),
        iv:                base64ToBytes(parsed.iv),
        tag:               base64ToBytes(parsed.tag),
        signature:         base64ToBytes(parsed.signature),
        sender_public_key: base64ToBytes(parsed.sender_public_key),
        content_hash:      base64ToBytes(parsed.content_hash),
      };

      // Decrypt and verify digital signatures
      const decryptedBytes = verifyAndDecrypt(packet, this.localPrivateKeyHex);
      const plaintext = bytesToStr(decryptedBytes);

      if (this.onMessageCallback) {
        this.onMessageCallback(plaintext);
      }
    } catch (error) {
      console.error('[Secure Transport] Error decrypting or verifying digital signature of incoming packet:', error);
    }
  }

  isHandshakeComplete(): boolean {
    return this.handshakeCompleted;
  }

  getRemotePublicKey(): string | null {
    return this.remotePublicKeyHex;
  }
}

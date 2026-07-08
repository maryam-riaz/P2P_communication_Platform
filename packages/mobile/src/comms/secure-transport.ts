import { PeerTransport } from './transport';
import { 
  EncryptedPacket, 
  encryptAndSign, 
  verifyAndDecrypt 
} from 'shared';

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
    const payload = Buffer.from(keyMsg, 'utf-8');
    await this.rawTransport.send(new Uint8Array(payload));
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

    const plaintextBytes = Buffer.from(plaintext, 'utf-8');
    
    // Encrypt and sign the payload using ECDH P-256 and AES-256-GCM
    const packet: EncryptedPacket = encryptAndSign(
      plaintextBytes,
      this.localPrivateKeyHex,
      this.localPublicKeyHex,
      this.remotePublicKeyHex
    );

    // Serialize packet to JSON and send as bytes
    const serialized = JSON.stringify({
      payload: Buffer.from(packet.payload).toString('base64'),
      iv: Buffer.from(packet.iv).toString('base64'),
      tag: Buffer.from(packet.tag).toString('base64'),
      signature: Buffer.from(packet.signature).toString('base64'),
      sender_public_key: Buffer.from(packet.sender_public_key).toString('base64'),
      content_hash: Buffer.from(packet.content_hash).toString('base64')
    });

    const payloadBytes = Buffer.from(serialized, 'utf-8');
    await this.rawTransport.send(new Uint8Array(payloadBytes));
  }

  private handleRawReceivedData(data: Uint8Array): void {
    const rawStr = Buffer.from(data).toString('utf-8');

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
        payload: new Uint8Array(Buffer.from(parsed.payload, 'base64')),
        iv: new Uint8Array(Buffer.from(parsed.iv, 'base64')),
        tag: new Uint8Array(Buffer.from(parsed.tag, 'base64')),
        signature: new Uint8Array(Buffer.from(parsed.signature, 'base64')),
        sender_public_key: new Uint8Array(Buffer.from(parsed.sender_public_key, 'base64')),
        content_hash: new Uint8Array(Buffer.from(parsed.content_hash, 'base64'))
      };

      // Decrypt and verify digital signatures
      const decryptedBytes = verifyAndDecrypt(packet, this.localPrivateKeyHex);
      const plaintext = Buffer.from(decryptedBytes).toString('utf-8');

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

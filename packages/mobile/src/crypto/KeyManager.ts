import 'react-native-get-random-values';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

const PRIVATE_KEY_STORE_KEY = 'sosify_x25519_private';

export class KeyManager {
  private keypair: nacl.BoxKeyPair | null = null;

  async initialize(): Promise<void> {
    const stored = await SecureStore.getItemAsync(PRIVATE_KEY_STORE_KEY);
    if (stored) {
      const secretKey = decodeBase64(stored);
      this.keypair = nacl.box.keyPair.fromSecretKey(secretKey);
    } else {
      this.keypair = nacl.box.keyPair();
      await SecureStore.setItemAsync(
        PRIVATE_KEY_STORE_KEY,
        encodeBase64(this.keypair.secretKey),
      );
    }
  }

  getKeypair(): nacl.BoxKeyPair {
    if (!this.keypair) throw new Error('KeyManager not initialized');
    return this.keypair;
  }

  getPublicKey(): Uint8Array {
    return this.getKeypair().publicKey;
  }

  getPublicKeyB64(): string {
    return encodeBase64(this.getPublicKey());
  }

  getFingerprint(): string {
    const hash = nacl.hash(this.getPublicKey());
    return Array.from(hash.slice(0, 32))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

export const keyManager = new KeyManager();

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
}

export function encryptForPeer(
  plaintext: string,
  theirPublicKey: Uint8Array,
  ourSecretKey: Uint8Array,
): EncryptedPayload {
  const sharedKey = nacl.box.before(theirPublicKey, ourSecretKey);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plainBytes = decodeUTF8(plaintext);
  const cipherBytes = nacl.secretbox(plainBytes, nonce, sharedKey);
  if (!cipherBytes) {
    throw new Error('Encryption failed');
  }
  return {
    ciphertext: encodeBase64(cipherBytes),
    nonce: encodeBase64(nonce),
  };
}

export function decryptFromPeer(
  ciphertext: string,
  nonce: string,
  theirPublicKey: Uint8Array,
  ourSecretKey: Uint8Array,
): string | null {
  try {
    const sharedKey = nacl.box.before(theirPublicKey, ourSecretKey);
    const cipherBytes = decodeBase64(ciphertext);
    const nonceBytes = decodeBase64(nonce);
    const plainBytes = nacl.secretbox.open(cipherBytes, nonceBytes, sharedKey);
    if (!plainBytes) return null;
    return encodeUTF8(plainBytes);
  } catch {
    return null;
  }
}

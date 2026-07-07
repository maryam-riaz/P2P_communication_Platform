import { gcm } from '@noble/ciphers/aes';

export interface EncryptedData {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

/**
 * Generates secure random bytes using cross-platform APIs.
 */
function getRandomValues(array: Uint8Array): Uint8Array {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    return globalThis.crypto.getRandomValues(array);
  }
  // fallback using eval to hide require from static analyzers
  try {
    const req = eval('require');
    const nodeCrypto = req('crypto');
    if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') {
      const bytes = nodeCrypto.randomBytes(array.length);
      array.set(bytes);
      return array;
    }
  } catch (e) {}
  throw new Error('No secure random number generator available');
}

/**
 * Encrypts data using AES-256-GCM.
 * Generates a random 12-byte IV and returns the ciphertext, IV, and 16-byte authentication tag.
 */
export function encrypt(plaintext: Uint8Array, key: Uint8Array): EncryptedData {
  if (key.length !== 32) {
    throw new Error('AES-256 key must be exactly 32 bytes (256 bits)');
  }
  
  const iv = getRandomValues(new Uint8Array(12)); // Standard for AES-GCM
  const aesGcm = gcm(key, iv);
  const encrypted = aesGcm.encrypt(plaintext);
  
  // @noble/ciphers/aes GCM returns ciphertext || tag
  const ciphertext = encrypted.slice(0, -16);
  const tag = encrypted.slice(-16);
  
  return {
    ciphertext,
    iv,
    tag,
  };
}

/**
 * Decrypts data using AES-256-GCM.
 * Verifies the 16-byte authentication tag before returning the decrypted plaintext.
 * Throws an error if authentication fails.
 */
export function decrypt(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  tag: Uint8Array,
  key: Uint8Array
): Uint8Array {
  if (key.length !== 32) {
    throw new Error('AES-256 key must be exactly 32 bytes (256 bits)');
  }
  
  // @noble/ciphers/aes GCM expects ciphertext || tag
  const encrypted = new Uint8Array(ciphertext.length + tag.length);
  encrypted.set(ciphertext);
  encrypted.set(tag, ciphertext.length);
  
  try {
    const aesGcm = gcm(key, iv);
    return aesGcm.decrypt(encrypted);
  } catch (error) {
    throw new Error('Decryption failed: authenticity tag validation failed (tampered data)');
  }
}

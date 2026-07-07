import * as crypto from 'crypto';

export interface EncryptedData {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

/**
 * Encrypts data using AES-256-GCM.
 * Generates a random 12-byte IV and returns the ciphertext, IV, and 16-byte authentication tag.
 */
export function encrypt(plaintext: Uint8Array, key: Uint8Array): EncryptedData {
  if (key.length !== 32) {
    throw new Error('AES-256 key must be exactly 32 bytes (256 bits)');
  }
  
  const iv = crypto.randomBytes(12); // Standard for AES-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16-byte tag is standard
  
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    tag: new Uint8Array(tag),
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
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(tag));
  
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext)),
      decipher.final(),
    ]);
    return new Uint8Array(plaintext);
  } catch (error) {
    throw new Error('Decryption failed: authenticity tag validation failed (tampered data)');
  }
}

import { deriveSharedSecret, sharedSecretToAesKey } from './ecdh';
import { encrypt, decrypt } from './aes-gcm';
import { sign, verify } from './ecdsa';
import { hash } from './sha256';

export interface EncryptedPacket {
  payload: Uint8Array;          // AES-256-GCM ciphertext
  iv: Uint8Array;               // 12 bytes, random IV
  tag: Uint8Array;              // 16 bytes, auth tag
  signature: Uint8Array;        // ECDSA signature over (ciphertext || iv || tag)
  sender_public_key: Uint8Array; // DER public key bytes
  content_hash: Uint8Array;      // SHA-256 hash of plaintext
}

/**
 * Concatenates a list of Uint8Arrays into a single Uint8Array.
 */
export function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

const aesKeyCache = new Map<string, Uint8Array>();

function getCachedAesKey(privateKeyHex: string, publicKeyHex: string): Uint8Array {
  const cacheKey = `${privateKeyHex}:${publicKeyHex}`;
  let key = aesKeyCache.get(cacheKey);
  if (!key) {
    const sharedSecret = deriveSharedSecret(privateKeyHex, publicKeyHex);
    key = sharedSecretToAesKey(sharedSecret);
    aesKeyCache.set(cacheKey, key);
  }
  return key;
}

/**
 * Encrypts and signs a plaintext message for a specific recipient.
 * 
 * @param plaintext The message bytes to encrypt.
 * @param senderPrivateKeyHex Sender's P-256 private key (hex DER PKCS8).
 * @param senderPublicKeyHex Sender's P-256 public key (hex DER SPKI).
 * @param recipientPublicKeyHex Recipient's P-256 public key (hex DER SPKI).
 * @param skipSignature If true, bypasses ECDSA digital signing.
 */
export function encryptAndSign(
  plaintext: Uint8Array,
  senderPrivateKeyHex: string,
  senderPublicKeyHex: string,
  recipientPublicKeyHex: string,
  skipSignature = false
): EncryptedPacket {
  // 1. Derive AES key (cached for speed)
  const aesKey = getCachedAesKey(senderPrivateKeyHex, recipientPublicKeyHex);

  // 2. Encrypt
  const encrypted = encrypt(plaintext, aesKey);

  // 3. Hash
  const content_hash = hash(plaintext);

  let signature: any = new Uint8Array(0);
  if (!skipSignature) {
    const dataToSign = concatUint8Arrays([encrypted.ciphertext, encrypted.iv, encrypted.tag]);
    signature = sign(dataToSign, senderPrivateKeyHex) as any;
  }

  // Convert hex string → Uint8Array without Buffer (works in Hermes)
  const hexStr = senderPublicKeyHex;
  const senderPublicKeyBytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < senderPublicKeyBytes.length; i++) {
    senderPublicKeyBytes[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  }

  return {
    payload: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    signature,
    sender_public_key: senderPublicKeyBytes,
    content_hash,
  };
}

/**
 * Verifies the signature and decrypts the encrypted packet.
 * 
 * @param packet The encrypted packet structure.
 * @param recipientPrivateKeyHex Recipient's P-256 private key (hex DER PKCS8).
 * @param skipSignature If true, bypasses ECDSA digital signature verification.
 */
export function verifyAndDecrypt(
  packet: EncryptedPacket,
  recipientPrivateKeyHex: string,
  skipSignature = false
): Uint8Array {
  // Convert Uint8Array → hex string without Buffer (works in Hermes)
  const senderPublicKeyHex = Array.from(packet.sender_public_key)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // 1. Verify signature over (ciphertext || iv || tag)
  if (!skipSignature) {
    const signedData = concatUint8Arrays([packet.payload, packet.iv, packet.tag]);
    const isValidSignature = verify(signedData, packet.signature, senderPublicKeyHex);
    if (!isValidSignature) {
      throw new Error('Verification failed: ECDSA digital signature is invalid (forged or corrupted package)');
    }
  }

  // 2. Derive AES key (cached for speed)
  const aesKey = getCachedAesKey(recipientPrivateKeyHex, senderPublicKeyHex);

  // 3. Decrypt
  return decrypt(packet.payload, packet.iv, packet.tag, aesKey);
}

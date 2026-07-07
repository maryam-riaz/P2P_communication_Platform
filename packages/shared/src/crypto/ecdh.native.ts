import { p256 } from '@noble/curves/nist';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

export interface KeyPair {
  publicKey: string;  // Hex encoded DER SPKI
  privateKey: string; // Hex encoded DER PKCS8
}

/** Converts a hex string to Uint8Array without using Buffer */
function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

/** Converts a Uint8Array to lowercase hex string without using Buffer */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Concatenates multiple Uint8Arrays */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ASN.1 constant prefixes for P-256 keys (hex literals, converted lazily)
const PREFIX_SPKI_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200'; // 26 bytes
const PREFIX_PKCS8_HEX = '308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420'; // 36 bytes
const SEPARATOR_HEX = 'a144034200'; // 5 bytes

/**
 * Generates an ECDH P-256 (prime256v1) keypair.
 * Returns keys as hex-encoded DER strings for easy serialization over transport layers.
 */
export function generateKeyPair(): KeyPair {
  const privateKeyBytes = p256.utils.randomSecretKey();
  const publicKeyBytes = p256.getPublicKey(privateKeyBytes, false); // uncompressed 65 bytes

  // Construct DER SPKI public key
  const spkiBytes = concatBytes(hexToBytes(PREFIX_SPKI_HEX), publicKeyBytes);

  // Construct DER PKCS8 private key
  const pkcs8Bytes = concatBytes(
    hexToBytes(PREFIX_PKCS8_HEX),
    privateKeyBytes,
    hexToBytes(SEPARATOR_HEX),
    publicKeyBytes
  );

  return {
    publicKey: bytesToHex(spkiBytes),
    privateKey: bytesToHex(pkcs8Bytes),
  };
}

/**
 * Computes the ECDH shared secret between our private key and their public key.
 */
export function deriveSharedSecret(myPrivateKeyHex: string, theirPublicKeyHex: string): Uint8Array {
  const myPrivateKeyBytes = hexToBytes(myPrivateKeyHex).slice(36, 68);
  const theirPublicKeyBytes = hexToBytes(theirPublicKeyHex).slice(26); // starts at byte 26 (0x04)

  return p256.getSharedSecret(myPrivateKeyBytes, theirPublicKeyBytes);
}

/**
 * Stretches an ECDH shared secret into a 256-bit AES-256-GCM key using HKDF-SHA256.
 */
export function sharedSecretToAesKey(sharedSecret: Uint8Array): Uint8Array {
  const salt = new Uint8Array(0);
  const info = new TextEncoder().encode('disaster-p2p-key-derivation');
  return hkdf(sha256, sharedSecret, salt, info, 32);
}

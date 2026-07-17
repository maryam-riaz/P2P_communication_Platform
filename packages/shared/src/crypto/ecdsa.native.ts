import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** Converts a hex string to Uint8Array without using Buffer */
function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

/**
 * Signs a message using ECDSA-256 (prime256v1 with SHA-256).
 * Accepts the hex-encoded DER PKCS8 private key.
 * Returns the raw signature as a Uint8Array.
 */
export function sign(message: Uint8Array, privateKeyHex: string): Uint8Array {
  // Extract 32-byte private key from DER PKCS8
  const privateKeyBytes = hexToBytes(privateKeyHex).slice(36, 68);

  // Hash the message with SHA-256
  const msgHash = sha256(message);

  // Sign and return signature in DER format
  const sig = p256.sign(msgHash, privateKeyBytes);
  return p256.Signature.fromBytes(sig).toBytes('der');
}

/**
 * Verifies an ECDSA-256 signature against a message.
 * Accepts the hex-encoded DER SPKI public key.
 * Returns true if valid, false otherwise.
 */
export function verify(message: Uint8Array, signature: Uint8Array, publicKeyHex: string): boolean {
  try {
    // Extract 65-byte uncompressed public key from DER SPKI
    const publicKeyBytes = hexToBytes(publicKeyHex).slice(26);

    // Hash the message with SHA-256
    const msgHash = sha256(message);

    // Parse DER signature to compact signature format
    const parsedSig = p256.Signature.fromBytes(signature, 'der');
    const compactSig = parsedSig.toBytes();

    // Verify using p256
    return p256.verify(compactSig, msgHash, publicKeyBytes);
  } catch (error) {
    // If the public key is malformed or verification throws, return false
    return false;
  }
}

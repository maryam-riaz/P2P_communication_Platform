import { sha256 } from '@noble/hashes/sha2';

/**
 * Computes the SHA-256 hash of the input Uint8Array.
 * Returns the hash as a Uint8Array.
 */
export function hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

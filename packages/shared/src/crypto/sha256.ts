import * as crypto from 'crypto';

/**
 * Computes the SHA-256 hash of the input Uint8Array.
 * Returns the hash as a Uint8Array.
 */
export function hash(data: Uint8Array): Uint8Array {
  const sha256 = crypto.createHash('sha256');
  sha256.update(data);
  return new Uint8Array(sha256.digest());
}

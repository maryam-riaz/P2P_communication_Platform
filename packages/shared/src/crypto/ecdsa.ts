import * as crypto from 'crypto';

/**
 * Signs a message using ECDSA-256 (prime256v1 with SHA-256).
 * Accepts the hex-encoded DER PKCS8 private key.
 * Returns the raw signature as a Uint8Array.
 */
export function sign(message: Uint8Array, privateKeyHex: string): Uint8Array {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyHex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });

  const signer = crypto.createSign('SHA256');
  signer.update(message);
  return new Uint8Array(signer.sign(privateKey));
}

/**
 * Verifies an ECDSA-256 signature against a message.
 * Accepts the hex-encoded DER SPKI public key.
 * Returns true if valid, false otherwise.
 */
export function verify(message: Uint8Array, signature: Uint8Array, publicKeyHex: string): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });

    const verifier = crypto.createVerify('SHA256');
    verifier.update(message);
    return verifier.verify(publicKey, Buffer.from(signature));
  } catch (error) {
    // If the public key is malformed or verification throws, return false
    return false;
  }
}

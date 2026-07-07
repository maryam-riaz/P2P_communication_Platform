import * as crypto from 'crypto';

export interface KeyPair {
  publicKey: string;  // Hex encoded DER SPKI
  privateKey: string; // Hex encoded DER PKCS8
}

/**
 * Generates an ECDH P-256 (prime256v1) keypair.
 * Returns keys as hex-encoded DER strings for easy serialization over transport layers.
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
}

/**
 * Computes the ECDH shared secret between our private key and their public key.
 */
export function deriveSharedSecret(myPrivateKeyHex: string, theirPublicKeyHex: string): Uint8Array {
  const myPrivateKey = crypto.createPrivateKey({
    key: Buffer.from(myPrivateKeyHex, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  const theirPublicKey = crypto.createPublicKey({
    key: Buffer.from(theirPublicKeyHex, 'hex'),
    format: 'der',
    type: 'spki',
  });
  return crypto.diffieHellman({
    privateKey: myPrivateKey,
    publicKey: theirPublicKey,
  });
}

/**
 * Stretches an ECDH shared secret into a 256-bit AES-256-GCM key using HKDF-SHA256.
 */
export function sharedSecretToAesKey(sharedSecret: Uint8Array): Uint8Array {
  const salt = new Uint8Array(0);
  const info = Buffer.from('disaster-p2p-key-derivation');
  return new Uint8Array(crypto.hkdfSync(
    'sha256',
    sharedSecret,
    salt,
    info,
    32 // 256 bits
  ));
}

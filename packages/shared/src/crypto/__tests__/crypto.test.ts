import { generateKeyPair, deriveSharedSecret, sharedSecretToAesKey } from '../ecdh';
import { encrypt, decrypt } from '../aes-gcm';
import { sign, verify } from '../ecdsa';
import { hash } from '../sha256';
import { encryptAndSign, verifyAndDecrypt } from '../message-wrapper';

describe('Cryptographic Module Tests', () => {
  // 1. ECDH Key Exchange tests
  describe('ECDH Module', () => {
    it('should generate valid P-256 keypairs', () => {
      const keys = generateKeyPair();
      expect(keys.publicKey).toBeDefined();
      expect(keys.privateKey).toBeDefined();
      expect(typeof keys.publicKey).toBe('string');
      expect(typeof keys.privateKey).toBe('string');
    });

    it('should derive the same shared secret on both ends', () => {
      const aliceKeys = generateKeyPair();
      const bobKeys = generateKeyPair();

      const secretAlice = deriveSharedSecret(aliceKeys.privateKey, bobKeys.publicKey);
      const secretBob = deriveSharedSecret(bobKeys.privateKey, aliceKeys.publicKey);

      expect(secretAlice).toEqual(secretBob);
    });

    it('should stretch the shared secret into identical 256-bit (32-byte) AES keys', () => {
      const aliceKeys = generateKeyPair();
      const bobKeys = generateKeyPair();

      const secretAlice = deriveSharedSecret(aliceKeys.privateKey, bobKeys.publicKey);
      const secretBob = deriveSharedSecret(bobKeys.privateKey, aliceKeys.publicKey);

      const keyAlice = sharedSecretToAesKey(secretAlice);
      const keyBob = sharedSecretToAesKey(secretBob);

      expect(keyAlice.length).toBe(32);
      expect(keyAlice).toEqual(keyBob);
    });
  });

  // 2. AES-256-GCM tests
  describe('AES-256-GCM Module', () => {
    const key = new Uint8Array(32); // mock 32-byte key
    for (let i = 0; i < 32; i++) key[i] = i;

    it('should encrypt and decrypt a message successfully', () => {
      const plaintext = Buffer.from('Emergency SOS test message', 'utf-8');
      const encrypted = encrypt(plaintext, key);

      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv.length).toBe(12); // Standard IV size
      expect(encrypted.tag.length).toBe(16); // Standard auth tag size

      const decrypted = decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag, key);
      expect(Buffer.from(decrypted).toString('utf-8')).toBe('Emergency SOS test message');
    });

    it('should throw an error during encryption if the key size is incorrect', () => {
      const badKey = new Uint8Array(16);
      const plaintext = Buffer.from('test', 'utf-8');
      expect(() => encrypt(plaintext, badKey)).toThrow('must be exactly 32 bytes');
    });

    it('should throw an error during decryption if the key size is incorrect', () => {
      const badKey = new Uint8Array(16);
      expect(() => decrypt(new Uint8Array(10), new Uint8Array(12), new Uint8Array(16), badKey)).toThrow('must be exactly 32 bytes');
    });

    it('should throw an error during decryption if the ciphertext is modified (tampered)', () => {

      const plaintext = Buffer.from('Emergency SOS test message', 'utf-8');
      const encrypted = encrypt(plaintext, key);

      // Tamper with the ciphertext (flip a byte)
      const tamperedCiphertext = new Uint8Array(encrypted.ciphertext);
      tamperedCiphertext[0] = tamperedCiphertext[0] ^ 0xFF;

      expect(() => {
        decrypt(tamperedCiphertext, encrypted.iv, encrypted.tag, key);
      }).toThrow('Decryption failed');
    });

    it('should throw an error if the authentication tag is modified', () => {
      const plaintext = Buffer.from('Emergency SOS test message', 'utf-8');
      const encrypted = encrypt(plaintext, key);

      // Tamper with the tag
      const tamperedTag = new Uint8Array(encrypted.tag);
      tamperedTag[0] = tamperedTag[0] ^ 0xFF;

      expect(() => {
        decrypt(encrypted.ciphertext, encrypted.iv, tamperedTag, key);
      }).toThrow('Decryption failed');
    });
  });

  // 3. ECDSA Signing tests
  describe('ECDSA Signing Module', () => {
    it('should sign and verify signatures successfully', () => {
      const keys = generateKeyPair();
      const message = Buffer.from('Verify that I am Alice', 'utf-8');

      const signature = sign(message, keys.privateKey);
      expect(signature).toBeDefined();

      const isValid = verify(message, signature, keys.publicKey);
      expect(isValid).toBe(true);
    });

    it('should return false if the public key is malformed', () => {
      const message = Buffer.from('Verify that I am Alice', 'utf-8');
      const signature = new Uint8Array(64);
      const isValid = verify(message, signature, 'invalid-hex-key');
      expect(isValid).toBe(false);
    });

    it('should reject signatures if the message content has been altered', () => {

      const keys = generateKeyPair();
      const message = Buffer.from('Verify that I am Alice', 'utf-8');
      const alteredMessage = Buffer.from('Verify that I am Bob', 'utf-8');

      const signature = sign(message, keys.privateKey);
      const isValid = verify(alteredMessage, signature, keys.publicKey);
      expect(isValid).toBe(false);
    });

    it('should reject signatures if the signature itself is modified', () => {
      const keys = generateKeyPair();
      const message = Buffer.from('Verify that I am Alice', 'utf-8');

      const signature = sign(message, keys.privateKey);
      const tamperedSignature = new Uint8Array(signature);
      tamperedSignature[5] = tamperedSignature[5] ^ 0xFF;

      const isValid = verify(message, tamperedSignature, keys.publicKey);
      expect(isValid).toBe(false);
    });
  });

  // 4. SHA-256 Hashing tests
  describe('SHA-256 Hashing Module', () => {
    it('should return identical hash bytes for the same input', () => {
      const data = Buffer.from('hello-world', 'utf-8');
      const hash1 = hash(data);
      const hash2 = hash(data);

      expect(hash1).toEqual(hash2);
      expect(hash1.length).toBe(32); // SHA-256 is 32 bytes
    });

    it('should return completely different hash bytes for different inputs', () => {
      const hashA = hash(Buffer.from('data-a', 'utf-8'));
      const hashB = hash(Buffer.from('data-b', 'utf-8'));

      expect(hashA).not.toEqual(hashB);
    });
  });

  // 5. Integrated Wrapper tests
  describe('Integrated Crypto Wrapper', () => {
    it('should encrypt, sign, verify, and decrypt in one cycle', () => {
      const aliceKeys = generateKeyPair();
      const bobKeys = generateKeyPair();

      const plaintext = Buffer.from('Secure rescue operation instructions', 'utf-8');
      const packet = encryptAndSign(plaintext, aliceKeys.privateKey, aliceKeys.publicKey, bobKeys.publicKey);

      expect(packet.payload).toBeDefined();
      expect(packet.iv.length).toBe(12);
      expect(packet.tag.length).toBe(16);
      expect(packet.signature).toBeDefined();
      expect(packet.content_hash).toEqual(hash(plaintext));

      const decrypted = verifyAndDecrypt(packet, bobKeys.privateKey);
      expect(Buffer.from(decrypted).toString('utf-8')).toBe('Secure rescue operation instructions');
    });

    it('should reject packet decryption if signature verification fails (tampered packet structure)', () => {
      const aliceKeys = generateKeyPair();
      const bobKeys = generateKeyPair();

      const plaintext = Buffer.from('Secure rescue operation instructions', 'utf-8');
      const packet = encryptAndSign(plaintext, aliceKeys.privateKey, aliceKeys.publicKey, bobKeys.publicKey);

      // Modify the signature
      packet.signature[0] = packet.signature[0] ^ 0xFF;

      expect(() => {
        verifyAndDecrypt(packet, bobKeys.privateKey);
      }).toThrow('Verification failed');
    });
  });
});

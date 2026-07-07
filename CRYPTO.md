# Cryptographic Design Specification

This document details the security and cryptographic wrapper specifications for the disaster-resilient peer-to-peer (P2P) network.

---

## 1. Threat Model & Protections

When centralized infrastructure fails, civilian and emergency nodes must exchange rescue alerts directly. The network must protect against:
- **Eavesdropping (Confidentiality)**: Nearby adversarial observers must not be able to read message content or locations.
- **Tampering (Integrity)**: Nodes must detect and reject modified or forged packets.
- **Spoofing (Authenticity)**: Receivers must verify the sender is who they claim to be.
- **Replay Attacks**: Attackers should not be able to capture and re-send old emergency reports to drain rescue resources.

---

## 2. Cryptographic Protocols

To satisfy these requirements, we use a hybrid cryptosystem combining asymmetric key exchanges and symmetric encryption.

```
       [Sender Private] + [Recipient Public] --(ECDH)--> [Shared Secret]
                                                                |
                                                          (HKDF-SHA256)
                                                                |
  [Plaintext] --(AES-256-GCM)--> [Ciphertext, IV, Tag] <--- [AES Key]
                                           |
                                     (ECDSA Sign)
                                           |
                                      [Signature]
```

### Elliptic Curve Diffie-Hellman (ECDH)
- **Curve**: P-256 (NIST `prime256v1`, standard 256-bit curve).
- **Purpose**: Computes a shared secret key without exposing it over the network during peer contact.
- **KDF**: HKDF-SHA256 stretches the raw shared secret into a cryptographically strong 256-bit symmetric AES key.

### AES-256-GCM (Symmetric Encryption)
- **Algorithm**: Advanced Encryption Standard in Galois/Counter Mode.
- **Cipher**: AES-256 (256-bit key size).
- **IV (Initialization Vector)**: 12-byte random IV per packet. *Never reuse an IV with the same key.*
- **Tag**: 16-byte authentication tag ensuring integrity and ciphertext authenticity. Decryption automatically fails if the payload or header is modified.

### ECDSA (Digital Signatures)
- **Algorithm**: Elliptic Curve Digital Signature Algorithm.
- **Curve**: P-256 (NIST `prime256v1`).
- **Data Signed**: The combination of `(ciphertext || iv || tag)`.
- **Purpose**: Non-repudiation and proof of origin. Proves that the owner of the matching public key created the cipher block.

### SHA-256 (Hashing)
- **Purpose**: Message hashing for content integrity and grouping.
- **Content Deduplication**: Storing SHA-256 content hashes of incoming messages allows routers to drop duplicate packets forwarded over multiple mesh paths immediately.

---

## 3. Encrypted Packet Format

When serialized over the socket stream, the encrypted packet structure is encapsulated as follows:

```json
{
  "payload": "<Base64 Ciphertext>",
  "iv": "<Base64 12-byte IV>",
  "tag": "<Base64 16-byte Auth Tag>",
  "signature": "<Base64 ECDSA Signature>",
  "sender_public_key": "<Base64 DER Public Key>",
  "content_hash": "<Base64 SHA-256 Plaintext Hash>"
}
```

---

## 4. Verification Controls

During the `verifyAndDecrypt` cycle, the receiver performs these checks in order:
1. **Signature Verification**: Validates the ECDSA signature using the `sender_public_key`. If signature check fails, the packet is discarded immediately (prevents CPU exhaustion attacks by avoiding decryption of spoofed packets).
2. **Decryption & Tag Verification**: Derives the symmetric AES key via ECDH and decrypts the ciphertext. GCM automatically validates the tag. If verification fails, decryption throws a cryptographic error.

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { logm, warnm } from '../utils/logger';

const TAG = 'KEYX';

interface PeerKeyRecord {
  publicKey: Uint8Array;
  fingerprint: string;
}

export class KeyExchange {
  private peers = new Map<string, PeerKeyRecord>();

  registerPeerKey(peerId: string, publicKeyB64: string): string {
    const publicKey = decodeBase64(publicKeyB64);
    const hash = nacl.hash(publicKey);
    const fingerprint = Array.from(hash.slice(0, 32))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const existing = this.peers.get(peerId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        warnm(
          TAG,
          `Key mismatch for ${peerId}! Existing fingerprint: ${existing.fingerprint.substring(0, 16)}..., new: ${fingerprint.substring(0, 16)}...`,
        );
      }
      return fingerprint;
    }

    this.peers.set(peerId, { publicKey, fingerprint });
    logm(TAG, `Registered key for ${peerId}: ${fingerprint.substring(0, 16)}...`);
    return fingerprint;
  }

  getPublicKey(peerId: string): Uint8Array | null {
    return this.peers.get(peerId)?.publicKey ?? null;
  }

  getFingerprint(peerId: string): string | null {
    return this.peers.get(peerId)?.fingerprint ?? null;
  }

  hasPeerKey(peerId: string): boolean {
    return this.peers.has(peerId);
  }

  getAllPeerKeys(): Array<{ peerId: string; fingerprint: string }> {
    const result: Array<{ peerId: string; fingerprint: string }> = [];
    this.peers.forEach((rec, peerId) => {
      result.push({ peerId, fingerprint: rec.fingerprint });
    });
    return result;
  }

  removePeerKey(peerId: string): void {
    this.peers.delete(peerId);
  }
}

export const keyExchange = new KeyExchange();

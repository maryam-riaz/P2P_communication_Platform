import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logm, errm } from '../utils/logger';

const TAG = 'CRED';

export interface RoleCredential {
  deviceId: string;
  role: 'user' | 'responder' | 'admin';
  publicKey: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

function buildCredentialMessage(cred: Omit<RoleCredential, 'signature'>): Uint8Array {
  const msg = `${cred.deviceId}:${cred.role}:${cred.publicKey}:${cred.issuedAt}:${cred.expiresAt}`;
  return decodeUTF8(msg);
}

export async function requestCredential(
  supabase: SupabaseClient,
  deviceId: string,
  role: 'user' | 'responder' | 'admin',
  publicKey: string,
): Promise<RoleCredential | null> {
  try {
    const { data, error } = await supabase.functions.invoke('sign-credential', {
      body: { device_id: deviceId, role, public_key: publicKey },
    });
    if (error || !data?.credential) {
      errm(TAG, 'Failed to fetch credential', error);
      return null;
    }
    const now = Date.now();
    return {
      deviceId,
      role,
      publicKey,
      issuedAt: data.issued_at ?? now,
      expiresAt: data.expires_at ?? now + 7 * 24 * 60 * 60 * 1000,
      signature: data.credential,
    };
  } catch (err) {
    errm(TAG, 'requestCredential error', err);
    return null;
  }
}

export function verifyCredentialOffline(
  credential: RoleCredential,
  serverPublicKeyB64: string,
): boolean {
  try {
    if (Date.now() > credential.expiresAt) {
      logm(TAG, 'Credential expired');
      return false;
    }
    const msg = buildCredentialMessage(credential);
    const signature = decodeBase64(credential.signature);
    const serverPub = decodeBase64(serverPublicKeyB64);
    return nacl.sign.detached.verify(msg, signature, serverPub);
  } catch (err) {
    errm(TAG, 'verifyCredentialOffline error', err);
    return false;
  }
}

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import nacl from 'https://esm.sh/tweetnacl@1.0.3';
import { encodeBase64, decodeBase64, encodeUTF8 } from 'https://esm.sh/tweetnacl-util@0.15.1';

const SIGNING_SECRET_B64 = Deno.env.get('CREDENTIAL_SIGNING_SECRET') ?? '';
const SIGNING_SECRET = decodeBase64(SIGNING_SECRET_B64);

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const { device_id, role, public_key } = await req.json();
    if (!device_id || !role || !public_key) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
    }

    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    const message = `${device_id}:${role}:${public_key}:${now}:${expiresAt}`;
    const messageBytes = encodeUTF8(message);
    const signature = nacl.sign.detached(messageBytes, SIGNING_SECRET);

    return new Response(
      JSON.stringify({
        credential: encodeBase64(signature),
        issued_at: now,
        expires_at: expiresAt,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

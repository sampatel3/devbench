/**
 * Web Push — the phone leg, built on node's own crypto. No new dependency.
 *
 * Why this channel and not an easier one: every alternative (ntfy.sh, Pushover,
 * Telegram, email) stores the message CONTENT on somebody else's server, and the
 * content here is the operator's private work. Web Push payloads are end-to-end
 * encrypted under RFC 8291: sealed on this Mac with a key only the phone holds,
 * so Apple's relay carries an opaque blob and can see only that a push happened,
 * when, roughly how big, and to which device. That property is the whole reason
 * this channel was chosen, so `push.test.ts` decrypts a real payload to prove it
 * rather than taking it on trust.
 *
 * Two further precautions, because "encrypted in transit" is not the same as
 * "private":
 *  - the phone DECRYPTS onto a lock screen that mirrors to any paired Watch or
 *    Mac, so the payload carries a kind and a number and nothing else — see
 *    `notify.ts`. Issue titles, bodies and customer names never go in it.
 *  - the VAPID `sub` claim is sent to Apple on every push, so it is a neutral
 *    mailto. Putting the ts.net origin there would hand over the machine name
 *    and the tailnet for free.
 *
 * Nothing in this file talks to GitHub.
 */

import { createECDH, createHmac, createCipheriv, createSign, randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';

/**
 * Sent to Apple on every push, so it identifies nobody and nothing.
 *
 * `@localhost` was the first version and it was the wrong kind of neutral: push
 * services VALIDATE the `sub` claim, and a non-routable single-label domain is a
 * known source of a hard 400 `BadJwtToken`. That failure lands on the automatic
 * poll path, which is exactly where nobody is watching.
 *
 * `example.com` is reserved by IANA (RFC 2606) for precisely this: a real,
 * well-formed, permanently unregistrable domain. It reaches no one, and it
 * still does not hand over the machine name or the tailnet the way a `ts.net`
 * origin here would.
 */
export const VAPID_SUBJECT = 'mailto:worker-console@example.com';

export type VapidKeys = { publicKey: string; privateKey: string };

export type PushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * The keypair, generated on this machine and never leaving it.
 *
 * Written 0600 and — critically — the file it goes in is listed in `.gitignore`
 * in the same change that created it: this repo's ignore file names its secrets
 * individually (`state.json`, `accounts.json`), so an unlisted new secret is
 * untracked-but-unignored and the next `git add -A` commits the private key.
 */
export function loadOrCreateVapidKeys(file: string): VapidKeys {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>;
    if (typeof raw.publicKey === 'string' && typeof raw.privateKey === 'string' && raw.publicKey && raw.privateKey) {
      return { publicKey: raw.publicKey, privateKey: raw.privateKey };
    }
  } catch {
    /* missing or corrupt: make a new one rather than leaving push broken */
  }
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys: VapidKeys = {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  return keys;
}

const b64u = (b: Buffer): string => b.toString('base64url');

/**
 * The signing key, from the raw 32-byte scalar we stored.
 *
 * Via JWK rather than hand-assembled DER: the DER version is a fixed byte
 * template that is silently wrong the moment anything about the curve encoding
 * differs, and node then fails with `DECODER routines::unsupported` at signing
 * time — a runtime error on the one code path that only runs when the operator is
 * away from their desk. JWK is checked by node itself.
 */
function privateKeyObject(rawPrivate: Buffer, rawPublic: Buffer) {
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64u(rawPrivate),
      x: b64u(rawPublic.subarray(1, 33)),
      y: b64u(rawPublic.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

/** The `Authorization: vapid t=<jwt>, k=<pubkey>` header for one push origin. */
export function vapidAuthHeader(endpoint: string, keys: VapidKeys, now = new Date()): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud,
        // Twelve hours: comfortably inside the 24h maximum, and long enough that
        // a console left running does not re-sign on every poll.
        exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
        sub: VAPID_SUBJECT,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const rawPrivate = Buffer.from(keys.privateKey, 'base64url');
  const rawPublic = Buffer.from(keys.publicKey, 'base64url');
  const der = createSign('SHA256').update(signingInput).sign(privateKeyObject(rawPrivate, rawPublic));
  return `vapid t=${signingInput}.${b64u(derToJose(der))}, k=${keys.publicKey}`;
}

/** ES256 signatures are raw r||s on the wire; node signs DER. */
function derToJose(der: Buffer): Buffer {
  let offset = 2;
  if (der[1]! & 0x80) offset += der[1]! & 0x7f;
  const readInt = (): Buffer => {
    offset += 1; // 0x02
    const len = der[offset]!;
    offset += 1;
    let v = der.subarray(offset, offset + len);
    offset += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  return Buffer.concat([readInt(), readInt()]);
}

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/** HKDF with a single-block expand, which is all any of these outputs need. */
function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

/**
 * RFC 8291 / RFC 8188 `aes128gcm`. An ephemeral keypair per message, a shared
 * secret with the subscription's public key, and the auth secret as the HKDF
 * salt — so only the device that created the subscription can open it.
 */
export function encryptPushPayload(plaintext: string, sub: PushSubscription): Buffer {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');
  const auth = Buffer.from(sub.keys.auth, 'base64url');

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const senderPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const salt = randomBytes(16);
  const prkInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, senderPublic]);
  const ikm = hkdf(shared, auth, prkInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 is the last-record delimiter from RFC 8188.
  const body = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, recordSize, Buffer.from([senderPublic.length]), senderPublic, ciphertext]);
}

/** The push service says the subscription no longer exists. Nothing else does. */
export function isSubscriptionGone(status: number): boolean {
  return status === 404 || status === 410;
}

export type PushResult = { ok: boolean; gone: boolean; status: number; error: string | null };

/** Injected so no test ever reaches Apple. */
export type PushFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Buffer },
) => Promise<{ status: number; text: string }>;

const defaultFetch: PushFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: new Uint8Array(init.body) });
  return { status: res.status, text: await res.text().catch(() => '') };
};

export async function sendPush(
  sub: PushSubscription,
  message: { kind: string; title: string; body: string; path: string },
  keys: VapidKeys,
  fetchImpl: PushFetch = defaultFetch,
): Promise<PushResult> {
  let body: Buffer;
  try {
    body = encryptPushPayload(JSON.stringify(message), sub);
  } catch (e) {
    return { ok: false, gone: false, status: 0, error: (e as Error).message };
  }
  try {
    const res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthHeader(sub.endpoint, keys),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'normal',
      },
      body,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, gone: false, status: res.status, error: null };
    return {
      ok: false,
      gone: isSubscriptionGone(res.status),
      status: res.status,
      error: res.text.split('\n')[0] || `HTTP ${res.status}`,
    };
  } catch (e) {
    // A network failure is not a dead subscription. Dropping one on ECONNRESET
    // would silently unsubscribe the phone the first time the wifi dropped.
    return { ok: false, gone: false, status: 0, error: (e as Error).message };
  }
}

/**
 * The banner. A push channel that has quietly stopped working is worse than no
 * push channel, because the operator would be relying on it — so an expired
 * subscription is said out loud rather than swallowed.
 */
export function pushProblemBanner(removed: number): string | null {
  if (removed <= 0) return null;
  const plural = removed === 1 ? ['subscription', 'was'] : ['subscriptions', 'were'];
  return `Phone notifications stopped — ${removed} ${plural[0]} expired and ${plural[1]} removed. Re-enable from your phone.`;
}

/**
 * The other banner: the phone is still registered, and the relay refused it.
 *
 * 400 `BadJwtToken`, 403 `VapidPkHashMismatch` (what a regenerated
 * `push-keys.json` produces — permanently), 429, 500. None of these is a dead
 * subscription, so none of them removes anything; all of them mean the phone
 * leg is not working, which is the one thing this feature must never be quiet
 * about. The relay's own words are repeated verbatim rather than translated,
 * for the same reason `sendTestPush` repeats them.
 */
export function pushRefusedBanner(error: string | null): string | null {
  if (!error) return null;
  return `Phone notifications are not getting through — the push service refused them (${error}). Re-register this device from Settings.`;
}

/**
 * The public key, for `GET /api/push/vapid`.
 *
 * It used to say "public key + whether a pairing code is needed". There is no
 * pairing code: it was designed and never built, and the sentence was the only
 * thing suggesting `/api/push/subscribe` was gated. It is not — any device on
 * the tailnet can register itself, and the console's answer to that today is a
 * hard cap plus a visible device count (see `savePushSubscription`), not a
 * pairing step.
 */
export function publicVapid(keys: VapidKeys): { publicKey: string } {
  return { publicKey: keys.publicKey };
}

export { createPublicKey };

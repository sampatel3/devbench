import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import {
  loadOrCreateVapidKeys,
  vapidAuthHeader,
  encryptPushPayload,
  sendPush,
  isSubscriptionGone,
  pushProblemBanner,
  VAPID_SUBJECT,
  type PushSubscription,
} from '../src/push.js';

/**
 * Web Push, built on node's own crypto — no new dependency, and nothing here
 * talks to GitHub. The choice of Web Push over every alternative rests on one
 * property, so that property is tested: the payload is encrypted on this Mac
 * (RFC 8291) and only the phone can open it. Apple carries a sealed envelope.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-push-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A subscription with keys we hold the private half of, so a test can actually
 *  decrypt what the sender produced. */
function fakeSubscription(): { sub: PushSubscription; privateKey: Buffer; auth: Buffer } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    sub: {
      endpoint: 'https://web.push.apple.com/abc123',
      keys: {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: auth.toString('base64url'),
      },
    },
    privateKey: ecdh.getPrivateKey(),
    auth,
  };
}

describe('VAPID keys — generated here, kept here', () => {
  it('creates a keypair on first use and reuses it after', () => {
    const file = join(dir, 'push-keys.json');
    const a = loadOrCreateVapidKeys(file);
    const b = loadOrCreateVapidKeys(file);
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.privateKey).toBe(b.privateKey);
  });

  it('writes the private key 0600 — it is a secret on a shared laptop', () => {
    const file = join(dir, 'push-keys.json');
    loadOrCreateVapidKeys(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('the public key is a raw uncompressed P-256 point, which is what the browser wants', () => {
    const { publicKey } = loadOrCreateVapidKeys(join(dir, 'push-keys.json'));
    const raw = Buffer.from(publicKey, 'base64url');
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(0x04);
  });

  it('regenerates rather than throwing when the file is corrupt', () => {
    const file = join(dir, 'push-keys.json');
    require('node:fs').writeFileSync(file, 'not json');
    expect(loadOrCreateVapidKeys(file).publicKey).toMatch(/.+/);
  });

  it('the VAPID subject is a neutral mailto, never the machine’s tailnet name', () => {
    // The subject is sent to Apple on every push. Putting the ts.net origin in
    // it would hand over the machine and tailnet name for free.
    expect(VAPID_SUBJECT).toMatch(/^mailto:/);
    expect(VAPID_SUBJECT).not.toContain('ts.net');
  });
});

describe('the JWT Apple checks', () => {
  it('is a three-part ES256 token for the push origin, expiring within 24h', () => {
    const keys = loadOrCreateVapidKeys(join(dir, 'push-keys.json'));
    const header = vapidAuthHeader('https://web.push.apple.com/abc123', keys, new Date('2026-08-12T12:00:00Z'));
    expect(header).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const jwt = header.slice('vapid t='.length).split(',')[0]!;
    const [h, p] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(claims.aud).toBe('https://web.push.apple.com');
    expect(claims.sub).toBe(VAPID_SUBJECT);
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(Date.parse('2026-08-12T12:00:00Z') / 1000) + 86_400);
  });
});

describe('the payload leaves this machine sealed', () => {
  it('produces aes128gcm ciphertext that is not the plaintext', () => {
    const { sub } = fakeSubscription();
    const body = encryptPushPayload(JSON.stringify({ title: 'UAT fail — issue #4334' }), sub);
    expect(body.toString('utf8')).not.toContain('4334');
    expect(body.toString('utf8')).not.toContain('UAT');
    // aes128gcm: 16-byte salt, 4-byte record size, 1-byte key id length, then the
    // sender's 65-byte public key.
    expect(body.length).toBeGreaterThan(16 + 4 + 1 + 65);
    expect(body[20]).toBe(65);
  });

  it('the SUBSCRIBER can decrypt it — the seal is real, not decoration', () => {
    const { sub, privateKey, auth } = fakeSubscription();
    const plaintext = JSON.stringify({ title: 'UAT fail — issue #4334', body: 'open the console' });
    const body = encryptPushPayload(plaintext, sub);

    // RFC 8291 in reverse, done by hand here so the test proves the sender, not
    // a shared helper.
    const salt = body.subarray(0, 16);
    const senderPublic = body.subarray(21, 21 + 65);
    const ciphertext = body.subarray(21 + 65);

    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateKey);
    const shared = ecdh.computeSecret(senderPublic);
    const uaPublic = ecdh.getPublicKey();

    const hmac = (key: Buffer, data: Buffer) => require('node:crypto').createHmac('sha256', key).update(data).digest();
    const hkdf = (ikm: Buffer, saltB: Buffer, info: Buffer, len: number) =>
      hmac(hmac(saltB, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

    const prkInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, senderPublic]);
    const ikm = hkdf(shared, auth, prkInfo, 32);
    const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

    const decipher = require('node:crypto').createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const out = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
    // Trailing 0x02 delimiter, per RFC 8188.
    expect(out.subarray(0, out.length - 1).toString('utf8')).toBe(plaintext);
    expect(out[out.length - 1]).toBe(0x02);
  });

  it('never sends a raw hash of anything identifying', () => {
    const { sub } = fakeSubscription();
    const body = encryptPushPayload('x', sub);
    expect(body.includes(createHash('sha256').update('example-org/example-repo').digest())).toBe(false);
  });
});

describe('a dead subscription surfaces instead of failing silently', () => {
  const keys = () => loadOrCreateVapidKeys(join(dir, 'push-keys.json'));

  it('404 and 410 mean the phone is gone', () => {
    expect(isSubscriptionGone(404)).toBe(true);
    expect(isSubscriptionGone(410)).toBe(true);
    expect(isSubscriptionGone(429)).toBe(false);
    expect(isSubscriptionGone(201)).toBe(false);
  });

  it('reports `gone` so the caller can drop the subscription and say why', async () => {
    const { sub } = fakeSubscription();
    const r = await sendPush(sub, { title: 't', body: 'b', path: '/', kind: 'uat-fail' }, keys(), async () => ({
      status: 410,
      text: 'gone',
    }));
    expect(r).toEqual({ ok: false, gone: true, status: 410, error: 'gone' });
  });

  it('a transient failure is NOT gone — the subscription survives a bad network', async () => {
    const { sub } = fakeSubscription();
    const r = await sendPush(sub, { title: 't', body: 'b', path: '/', kind: 'uat-fail' }, keys(), async () => {
      throw new Error('ECONNRESET');
    });
    expect(r.gone).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('a good send reports ok, and posts to the subscription endpoint with the aes128gcm headers', async () => {
    const { sub } = fakeSubscription();
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const r = await sendPush(sub, { title: 't', body: 'b', path: '/', kind: 'uat-fail' }, keys(), async (url, init) => {
      seen = { url, headers: init.headers };
      return { status: 201, text: '' };
    });
    expect(r.ok).toBe(true);
    expect(seen!.url).toBe(sub.endpoint);
    expect(seen!.headers['Content-Encoding']).toBe('aes128gcm');
    expect(seen!.headers['TTL']).toBe('86400');
    expect(seen!.headers.Authorization).toMatch(/^vapid t=/);
  });

  it('the banner names the problem in the operator’s words, and is null when there is none', () => {
    expect(pushProblemBanner(2)).toBe(
      'Phone notifications stopped — 2 subscriptions expired and were removed. Re-enable from your phone.',
    );
    expect(pushProblemBanner(1)).toBe(
      'Phone notifications stopped — 1 subscription expired and was removed. Re-enable from your phone.',
    );
    expect(pushProblemBanner(0)).toBeNull();
  });
});

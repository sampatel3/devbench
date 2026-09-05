/**
 * The browser's half of the phone leg.
 *
 * The failure this file exists to stop is the nastiest one in the feature,
 * because it is invisible from both ends:
 *
 *   `loadOrCreateVapidKeys` REGENERATES on a corrupt or missing
 *   `push-keys.json` — a deliberate choice, so a lost key file does not leave
 *   push permanently broken. But a subscription minted under the OLD key is
 *   still a perfectly valid subscription object, so `getSubscription()` hands it
 *   straight back, and every push against it is refused 403
 *   `VapidPkHashMismatch` for ever. The button labelled "Re-register this
 *   device" then returns the same dead subscription and reports success.
 *
 * So the browser has to check that the subscription it already has was minted
 * under the key the console is holding RIGHT NOW.
 */
import { describe, it, expect } from 'vitest';
import { subscriptionMatchesKey } from '../../ui/src/push.js';

/** base64url → bytes, the same transform the real subscribe path uses. */
const bytes = (b64: string): ArrayBuffer => {
  const padded = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = Buffer.from(padded, 'base64');
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
};

const KEY_A = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const KEY_B = 'BMxLnMBOsxtEzL0-nRxeE2C0KFmxOpvvNjJHV-Rl0OVGL-fkFXhqJHhqZ9Cx7lJ5jKcMfrjLXwHi5xLbTQxKQOc';

const subWith = (key: string | null) => ({
  options: { applicationServerKey: key === null ? null : bytes(key) },
});

describe('a subscription is only reusable under the key that minted it', () => {
  it('matches when the console still holds the same VAPID key', () => {
    expect(subscriptionMatchesKey(subWith(KEY_A), KEY_A)).toBe(true);
  });

  it('does NOT match after the console regenerated its keypair', () => {
    // This is the 403 VapidPkHashMismatch case. Reusing here is what made
    // "Re-register this device" a button that cannot recover.
    expect(subscriptionMatchesKey(subWith(KEY_A), KEY_B)).toBe(false);
  });

  it('does not match when the browser will not say which key was used', () => {
    // Unknown provenance is not evidence of a match. Re-subscribing costs one
    // round trip; getting this wrong costs every push, silently.
    expect(subscriptionMatchesKey(subWith(null), KEY_A)).toBe(false);
    expect(subscriptionMatchesKey({}, KEY_A)).toBe(false);
    expect(subscriptionMatchesKey({ options: {} }, KEY_A)).toBe(false);
  });

  it('does not match a truncated or padded key of the same prefix', () => {
    const short = bytes(KEY_A).slice(0, 32);
    expect(subscriptionMatchesKey({ options: { applicationServerKey: short } }, KEY_A)).toBe(false);
  });

  it('survives a key the console cannot even decode, rather than throwing', () => {
    expect(subscriptionMatchesKey(subWith(KEY_A), '!!!not base64!!!')).toBe(false);
  });
});

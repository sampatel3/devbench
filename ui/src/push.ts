/**
 * Phone notifications, from the browser's side.
 *
 * The console is a local page, and everything about it says so — but this one
 * feature reaches off the machine, so the honesty has to be built in rather than
 * written in a paragraph nobody reads:
 *
 *  - The payload is sealed on the Mac (RFC 8291) and opened only on the phone.
 *    Apple's relay carries an opaque blob. It is minimal anyway: a kind and a
 *    number, never a title, a body, or a customer name.
 *  - iOS will only do any of this for a page **added to the Home Screen**, over
 *    **HTTPS**, after a **tap**. Those three are checked explicitly and reported
 *    in the words that say what to do, because the failure otherwise is a button
 *    that appears to do nothing.
 *  - The console never asks for permission on its own. Every call here is behind
 *    a click.
 */

export type PushReadiness = {
  /** This browser has the APIs at all. */
  supported: boolean;
  /** HTTPS (or localhost). Tailscale Serve over plain http fails here — and that
   *  is the single most likely reason this does not work on the phone. */
  secure: boolean;
  /** Running from the Home Screen icon rather than a Safari tab. iOS requires it. */
  standalone: boolean;
  /** iPhone or iPad, where the Home Screen rule applies. */
  ios: boolean;
  permission: NotificationPermission | 'unavailable';
  /** This browser is registered with the console right now. */
  subscribed: boolean;
};

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function isStandalone(): boolean {
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return Boolean(iosStandalone) || window.matchMedia('(display-mode: standalone)').matches;
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as a Mac; the touch-point count is what separates them.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export async function readReadiness(): Promise<PushReadiness> {
  const supported = pushSupported();
  const base: PushReadiness = {
    supported,
    secure: typeof window !== 'undefined' && window.isSecureContext,
    standalone: typeof window !== 'undefined' && isStandalone(),
    ios: typeof navigator !== 'undefined' && isIos(),
    permission: supported ? Notification.permission : 'unavailable',
    subscribed: false,
  };
  if (!supported || !base.secure) return base;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return { ...base, subscribed: sub !== null };
}

/**
 * The one sentence that says what to do about it, or null when nothing is in the
 * way. Ordered by what has to be true first.
 */
export function blockedReason(r: PushReadiness): string | null {
  if (!r.supported) return 'This browser cannot do phone notifications. Safari on iOS 16.4 or later, or Chrome, can.';
  if (!r.secure) {
    return (
      'This page is not on HTTPS, and a browser will not do push without it. Serve the console over HTTPS ' +
      '(tailscale serve --bg --https=443 127.0.0.1:4400) and open the https:// address.'
    );
  }
  if (r.ios && !r.standalone) {
    return 'On iPhone this only works from the Home Screen icon. Share → Add to Home Screen, then open the console from that icon and press this button again.';
  }
  if (r.permission === 'denied') {
    return 'Notifications are blocked for this site in the browser’s own settings. Allow them there, then press this button again.';
  }
  return null;
}

/**
 * base64url → the bytes `PushManager.subscribe` wants.
 *
 * Built on an explicit `ArrayBuffer` rather than the plain `new Uint8Array(n)`
 * constructor: the DOM types want a view over a real ArrayBuffer, and the plain
 * form widens to `ArrayBufferLike` (which includes `SharedArrayBuffer`).
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Was this subscription minted under the key the console is holding RIGHT NOW?
 *
 * `loadOrCreateVapidKeys` regenerates on a corrupt or missing `push-keys.json`,
 * on purpose — a lost key file must not leave push permanently broken. But a
 * subscription made under the previous key is still a structurally valid
 * subscription, so `getSubscription()` returns it happily and every push against
 * it is refused 403 `VapidPkHashMismatch`, for ever. Reusing it unchecked is
 * what made the button labelled "Re-register this device" incapable of
 * re-registering the device.
 *
 * Unknown provenance counts as NO match: re-subscribing costs one round trip,
 * and being wrong the other way costs every notification, silently.
 */
export function subscriptionMatchesKey(
  sub: { options?: { applicationServerKey?: ArrayBuffer | null } },
  publicKey: string,
): boolean {
  const raw = sub.options?.applicationServerKey;
  if (!raw) return false;
  let want: Uint8Array;
  try {
    want = urlBase64ToUint8Array(publicKey);
  } catch {
    return false;
  }
  const have = new Uint8Array(raw);
  if (have.length === 0 || have.length !== want.length) return false;
  return have.every((b, i) => b === want[i]);
}

/**
 * Register the worker, ask for permission, subscribe, and hand the subscription
 * to the console. Every step reports in plain English rather than throwing into
 * a console nobody has open on a phone.
 */
export async function enablePush(): Promise<{ ok: boolean; message: string }> {
  const readiness = await readReadiness();
  const blocked = blockedReason(readiness);
  if (blocked) return { ok: false, message: blocked };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, message: 'Not allowed — nothing was registered. Press the button again to be asked once more.' };
  }

  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;

  const res = await fetch('/api/push/vapid');
  const { publicKey } = (await res.json()) as { publicKey: string };
  if (!publicKey) return { ok: false, message: 'The console did not hand over a key. Is it still running?' };

  // A subscription minted under a PREVIOUS VAPID key is worse than none: it
  // looks healthy here and is refused 403 by the relay for ever. Drop it and
  // mint a new one, which is what pressing this button is supposed to do.
  let existing = await reg.pushManager.getSubscription();
  if (existing && !subscriptionMatchesKey(existing, publicKey)) {
    await existing.unsubscribe().catch(() => undefined);
    existing = null;
  }
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      // Always true, and not a choice: a push that displays nothing gets the
      // site's permission revoked by Safari.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const saved = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  const out = (await saved.json()) as { ok: boolean; message?: string };
  if (!out.ok) return { ok: false, message: out.message ?? 'The console would not store the subscription.' };
  return { ok: true, message: 'This device will now get pushes. Send a test to be sure.' };
}

/** Off, on both sides: the browser forgets it and the console stops sending. */
export async function disablePush(): Promise<{ ok: boolean; message: string }> {
  if (!pushSupported()) return { ok: false, message: 'Nothing to turn off here.' };
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return { ok: true, message: 'This device was not registered.' };
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  await sub.unsubscribe();
  return { ok: true, message: 'This device will no longer get pushes.' };
}

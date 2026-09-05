/**
 * The console's service worker. It exists for ONE reason: Web Push.
 *
 * It deliberately has NO `fetch` handler and caches nothing. This page is live
 * state — what is running on the Mac right now — and a cached copy of live state
 * is a page telling you lies about a machine you are not in front of. Off the
 * tailnet the console should fail to load, visibly. Adding an offline cache here
 * would be a regression, not a feature.
 *
 * The one hard invariant, which is why the error path below also shows a
 * notification: **every push must display something.** Safari revokes push
 * permission from a site that receives pushes silently, and the failure would be
 * "my phone stopped telling me about UAT fails" — discovered days later, if at
 * all. A push that cannot be parsed says so on screen rather than nothing.
 */

/* eslint-env serviceworker */

// Take over immediately rather than waiting for every tab to close. A phone that
// has just been told "notifications on" should be subscribed now, not next week.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  /** @type {{ kind?: string, title?: string, body?: string, path?: string }} */
  let payload = {};
  let parsed = false;
  try {
    payload = event.data ? event.data.json() : {};
    parsed = true;
  } catch {
    parsed = false;
  }

  const title = (parsed && payload.title) || 'New action on you';
  const body = (parsed && payload.body) || 'Open the console.';
  const path = (parsed && payload.path) || '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // One notification per kind+subject replaces the previous one rather than
      // stacking: three polls about the same UAT fail is one thing to fix, not
      // three lock-screen rows.
      tag: `${(parsed && payload.kind) || 'action'}:${path}`,
      renotify: true,
      data: { path },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || '/';
  const url = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Already open somewhere: focus that, rather than opening a second copy of
      // a console that is one live page by design.
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          if ('navigate' in client) client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

// Kepos service worker. It deliberately caches nothing, so testers always get the latest deploy.
// Its only job is to exist (with a fetch handler) so browsers treat the site as installable.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // No respondWith: every request goes straight to the network, unchanged.
});

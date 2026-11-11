// Service worker for the installable "DCF Farm" app (scope /farm only). It does not cache anything:
// farm records must always be live, so every request goes straight to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// Service worker for the installable "DCF Farm" app (scope /farm only).
// Farm records must always be live, so nothing is cached: every request is passed straight to the network.
// (A real fetch handler is kept because some Android Chrome versions only offer "Install" when one exists.)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DCF Farm</title>' +
    '<body style="margin:0;background:#1F1712;color:#EFE6D8;font:16px/1.5 system-ui,sans-serif;padding:2rem;text-align:center">' +
    '<p>No internet connection.</p><p>Farm records need the internet – please try again.</p></body>',
    {headers: {'Content-Type': 'text/html; charset=utf-8'}})));
});

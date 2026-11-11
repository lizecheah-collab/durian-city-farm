// Retired: /farm is now a plain home-screen shortcut, not an installed app.
// Phones that registered the earlier app helper load this once; it removes itself.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister()));

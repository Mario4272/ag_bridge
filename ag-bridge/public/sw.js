const CACHE_NAME = 'ag-bridge-v1';
const ASSETS = [
    '/',
    '/index.html',
    '/manifest.json'
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
    // Network first, fall back to cache for HTML/static assets
    if (e.request.method !== 'GET') return;

    e.respondWith(
        fetch(e.request)
            .catch(() => caches.match(e.request))
    );
});

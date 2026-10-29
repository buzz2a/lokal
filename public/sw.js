// Network first for pages and anything without a hashed name, so a new build
// shows up on the next load (the cache only answers offline). Files under
// /assets/ carry their content hash in the name, so they are safe to serve
// from the cache first. A new CACHE name drops what older workers kept.
const CACHE = 'lokal-v2'

self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})

function remember(request, response) {
  if (response.ok) {
    const copy = response.clone()
    caches.open(CACHE).then(c => c.put(request, copy))
  }
  return response
}

self.addEventListener('fetch', e => {
  const request = e.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/stream/')) return
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(request).then(hit => hit || fetch(request).then(res => remember(request, res))))
    return
  }
  e.respondWith(fetch(request).then(res => remember(request, res)).catch(() =>
    caches.match(request).then(hit => hit || (request.mode === 'navigate' ? caches.match('/') : Response.error()))))
})

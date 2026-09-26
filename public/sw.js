// Оболочка приложения для установки на телефон. Данные (база, файлы, шрифты, курсы) идут
// мимо кэша: их отдаёт сеть, чтобы никогда не показывать устаревший склад или остатки.
const CACHE = 'fl-shell-v1'
const ROOT = new URL('./', self.location).href

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
  await self.clients.claim()
})()))

self.addEventListener('fetch', e => {
  const r = e.request
  if (r.method !== 'GET') return
  const u = new URL(r.url)
  if (u.origin !== self.location.origin) return

  // страницы: сеть, при обрыве — последняя оболочка (SPA открывается и без связи, дальше покажет «нет соединения»)
  if (r.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(r)
        // оболочка одна на все адреса SPA: запоминаем любой успешный ответ страницы как «корень»
        if (res.ok) {
          const copy = res.clone() // клон — до того, как страница заберёт тело ответа
          e.waitUntil(caches.open(CACHE).then(c => c.put(ROOT, copy)))
        }
        return res
      } catch {
        return (await caches.match(ROOT)) || Response.error()
      }
    })())
    return
  }

  // хешированные файлы сборки не меняются под тем же именем — можно отдавать из кэша
  if (u.pathname.includes('/assets/')) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(r)
      if (hit) return hit
      const res = await fetch(r)
      if (res.ok) cache.put(r, res.clone())
      return res
    })())
  }
})

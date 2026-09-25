// Эмуляция GitHub Pages для проекта: отдаёт dist под /first-logic/, а на
// неизвестные пути — 404.html со статусом 404, как настоящие Pages (без SPA-fallback).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('dist')
const base = '/first-logic/'
const port = Number(process.env.PORT ?? 4173)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  let file = null
  if (url.pathname.startsWith(base)) {
    const rel = decodeURIComponent(url.pathname.slice(base.length))
    const p = path.join(root, rel)
    if (p.startsWith(root)) {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) file = p
      else if (fs.existsSync(path.join(p, 'index.html'))) file = path.join(p, 'index.html')
    }
  }
  const status = file ? 200 : 404
  file ??= path.join(root, '404.html')
  res.writeHead(status, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(port, () => console.log(`pages-emulator on :${port}`))

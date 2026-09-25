// Выгрузка всех файлов из хранилища Supabase в папку (для резервной копии).
// Запуск: SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node scripts/backup-storage.mjs out/storage
// Ключ service_role нужен, чтобы видеть все файлы в обход RLS; держите его только в секретах.

import fs from 'node:fs/promises'
import path from 'node:path'

const url = process.env.SUPABASE_URL?.trim()
const key = process.env.SUPABASE_SERVICE_KEY?.trim()
const out = process.argv[2] ?? 'storage-backup'
const BUCKETS = ['ws-files', 'avatars']
if (!url || !key) { console.error('нужны SUPABASE_URL и SUPABASE_SERVICE_KEY'); process.exit(1) }

const headers = { apikey: key, Authorization: `Bearer ${key}` }

async function list(bucket, prefix) {
  const all = []
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    })
    if (!r.ok) throw new Error(`list ${bucket}/${prefix}: ${r.status} ${await r.text()}`)
    const page = await r.json()
    all.push(...page)
    if (page.length < 1000) return all
  }
}

/** Папки в ответе — записи без id; обходим рекурсивно. */
async function walk(bucket, prefix = '') {
  const files = []
  for (const e of await list(bucket, prefix)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name
    if (e.id === null) files.push(...await walk(bucket, p))
    else files.push(p)
  }
  return files
}

let total = 0, bytes = 0
for (const bucket of BUCKETS) {
  let files
  try { files = await walk(bucket) } catch (e) { console.warn(`бакет ${bucket}: ${e.message} — пропущен`); continue }
  for (const f of files) {
    const r = await fetch(`${url}/storage/v1/object/${bucket}/${f.split('/').map(encodeURIComponent).join('/')}`, { headers })
    if (!r.ok) { console.warn(`не скачан ${bucket}/${f}: ${r.status}`); continue }
    const buf = Buffer.from(await r.arrayBuffer())
    const dst = path.join(out, bucket, ...f.split('/'))
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.writeFile(dst, buf)
    total++; bytes += buf.length
  }
  console.log(`${bucket}: ${files.length} файлов`)
}
console.log(`итого: ${total} файлов, ${(bytes / 1024 / 1024).toFixed(1)} МБ`)

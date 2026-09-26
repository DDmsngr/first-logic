// Сквозная проверка HTTP-входа для сайта: собираем модуль так же, как Worker, и подменяем сеть.
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(mkdtempSync(join(tmpdir(), 'fl-api-')), 'api.mjs')
await build({ entryPoints: [join(here, '../src/api.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent' })
const { handleApi } = await import(pathToFileURL(out).href)

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'svc', DASHBOARD_URL: 'https://ddmsngr.github.io/first-logic', GEMINI: 'g', GEMINI_MODEL: 'm1' }
const ORIGIN = 'https://ddmsngr.github.io'
const call = (init = {}, body) => handleApi(new Request('https://bot.example/api/extract-tasks', {
  method: 'POST', headers: { Origin: ORIGIN, Authorization: 'Bearer good', 'Content-Type': 'application/json', ...init.headers },
  body: body === undefined ? JSON.stringify({ kind: 'text', text: 'Проверить КСВ', people: ['Иван'] }) : body, ...(init.method ? { method: init.method } : {}),
}), ENV)

/** Подмена сети: Supabase Auth, таблица участников, Gemini. */
function stub({ tokenOk = true, member = true, gemini = { candidates: [{ content: { parts: [{ text: JSON.stringify({ tasks: [{ title: 'Проверить КСВ', priority: 'high' }] }) }] } }] }, geminiStatus = 200 } = {}) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = String(url); calls.push(u)
    if (u.includes('/auth/v1/user')) return tokenOk ? Response.json({ id: 'u1' }) : new Response('{}', { status: 401 })
    if (u.includes('/rest/v1/ws_members')) return Response.json(member ? [{ id: 'm1' }] : [])
    if (u.includes('generativelanguage')) return geminiStatus === 200 ? Response.json(gemini) : new Response('{"error":"quota"}', { status: geminiStatus })
    throw new Error('неожиданный запрос ' + u)
  }
  return calls
}

test('не наш путь — пропускаем', async () => {
  assert.equal(await handleApi(new Request('https://bot.example/webhook', { method: 'POST' }), ENV), null)
})

test('предзапрос CORS: свой адрес пускаем, чужой нет', async () => {
  const ok = await handleApi(new Request('https://bot.example/api/extract-tasks', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), ENV)
  assert.equal(ok.status, 204); assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN)
  const bad = await handleApi(new Request('https://bot.example/api/extract-tasks', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), ENV)
  assert.equal(bad.status, 403)
})

test('без токена, с плохим токеном и не участник — отказ', async () => {
  stub()
  assert.equal((await call({ headers: { Authorization: '' } })).status, 401)
  stub({ tokenOk: false })
  assert.equal((await call()).status, 401)
  stub({ member: false })
  assert.equal((await call()).status, 403)
})

test('чужой адрес запроса отклоняется до проверки токена', async () => {
  const calls = stub()
  assert.equal((await call({ headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal(calls.length, 0)
})

test('успех: задачи из ответа модели, приведённые к формату', async () => {
  const calls = stub()
  const r = await call()
  assert.equal(r.status, 200)
  assert.deepEqual((await r.json()).tasks, [{ title: 'Проверить КСВ', priority: 'high' }])
  assert.ok(calls.some(c => c.includes('generativelanguage')))
})

test('модель перегружена — понятная 429; пустой документ — 400 без вызова модели', async () => {
  stub({ geminiStatus: 429 })
  const r = await call()
  assert.equal(r.status, 429)
  const calls = stub()
  const empty = await call({}, JSON.stringify({ kind: 'text', text: '   ' }))
  assert.equal(empty.status, 400)
  assert.ok(!calls.some(c => c.includes('generativelanguage')))
})

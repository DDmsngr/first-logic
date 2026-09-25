// Стенд: PGlite + заглушки Supabase + все миграции First Logic по порядку.
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Стенд для проверки миграций без облака: npm run test:db (в CI — каждый push).
const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', 'migrations')

/** Строки, которые стенд выполнить не может (расширения облака), вырезаем. */
function prep(sql) {
  return sql
    .replace(/^create extension if not exists http[^;]*;/gim, '-- (stub) http')
    .replace(/^create extension if not exists pg_cron[^;]*;/gim, '-- (stub) pg_cron')
}

export async function boot({ upTo } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(fs.readFileSync(path.join(HERE, 'stub.sql'), 'utf8'))
  const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (upTo && f > upTo) break
    try {
      await db.exec(prep(fs.readFileSync(path.join(MIG, f), 'utf8')))
    } catch (e) {
      throw new Error(`${f}: ${e.message}${e.position ? ` (pos ${e.position})` : ''}`)
    }
  }
  return db
}

/** Выполнить от имени пользователя (auth.uid()) — как делает PostgREST. */
export async function as(db, userId, fn) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false), set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false)`)
  try { return await fn() } finally {
    await db.exec(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false)`)
  }
}

/** Типовые данные: workspace first-logic, два участника (owner и admin). */
export async function seed(db) {
  const u1 = '00000000-0000-0000-0000-0000000000a1', u2 = '00000000-0000-0000-0000-0000000000a2'
  await db.exec(`insert into auth.users (id, email) values ('${u1}', 'a@x.ru'), ('${u2}', 'b@x.ru')`)
  const ws = (await db.query(`select id from ws_workspaces where slug = 'first-logic'`)).rows[0].id
  await db.exec(`select ws_bootstrap_owner('${ws}', 'a@x.ru', 'Алексей')`)
  await db.exec(`insert into ws_members (workspace_id, user_id, email, name, role, status, joined_at) values ('${ws}', '${u2}', 'b@x.ru', 'Иван', 'admin', 'active', now())`)
  const project = (await db.query(`select id from ws_projects where workspace_id = '${ws}'`)).rows[0].id
  return { ws, u1, u2, project }
}

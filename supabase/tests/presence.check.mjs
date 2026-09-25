import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1, u2 } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
await db.exec(`grant usage on schema public to authenticated`)
const asUser = (u, fn) => as(db, u, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })
const seen = async u => (await one(`select last_seen from ws_members where user_id = $1`, [u])).last_seen
const vis = async (mode, from, to) => (await one(`select ws_presence_visible($1, $2::time, $3::time, 'UTC') v`, [mode, from, to])).v
const nowUtc = (await one(`select to_char(now() at time zone 'UTC', 'HH24:MI') t`)).t
const shift = h => { const [H, M] = nowUtc.split(':').map(Number); return `${String((H + h + 24) % 24).padStart(2, '0')}:${String(M).padStart(2, '0')}` }

console.log('окно видимости')
assert.equal(await vis('always', '09:00', '10:00'), true); ok('всегда — видно')
assert.equal(await vis('never', '00:00', '23:59'), false); ok('никогда — не видно')
assert.equal(await vis('schedule', shift(-1), shift(1)), true); ok('сейчас внутри окна — видно')
assert.equal(await vis('schedule', shift(1), shift(2)), false); ok('окно впереди — не видно')
assert.equal(await vis('schedule', shift(-2), shift(-1)), false); ok('окно прошло — не видно')

console.log('ws_touch уважает настройку')
await asUser(u1, () => db.query(`update ws_members set presence_mode = 'schedule', presence_from = $1, presence_to = $2, presence_tz = 'UTC' where user_id = $3`, [shift(1), shift(2), u1]))
await db.query(`update ws_members set last_seen = null where user_id = $1`, [u1])
await asUser(u1, () => db.query(`select ws_touch($1)`, [ws]))
assert.equal(await seen(u1), null); ok('вне окна last_seen не пишется')
await asUser(u1, () => db.query(`update ws_members set presence_mode = 'always' where user_id = $1`, [u1]))
await asUser(u1, () => db.query(`select ws_touch($1)`, [ws]))
assert.ok(await seen(u1)); ok('«всегда» — пишется')
await asUser(u1, () => db.query(`update ws_members set presence_mode = 'never' where user_id = $1`, [u1]))
assert.equal(await seen(u1), null); ok('«никогда» стирает last_seen')

console.log('чужую видимость не поменять')
// владелец проходит политику админов, дальше его останавливает триггер
await asUser(u1, () => db.query(`update ws_members set presence_mode = 'never' where user_id = $1`, [u2])).catch(e => assert.match(e.message, /только сам участник/))
assert.equal((await one(`select presence_mode from ws_members where user_id = $1`, [u2])).presence_mode, 'always'); ok('у второго участника осталось «всегда»')
console.log('\nпроверки видимости пройдены')

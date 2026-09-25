import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? '', e.where ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1, u2 } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
await db.exec(`grant usage on schema public to authenticated`)
const asAuth = fn => as(db, u1, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })

const mem2 = (await one(`select id from ws_members where user_id = $1`, [u2])).id
await db.exec(`insert into fl_tg_links (member_id, tg_user_id, tg_chat_id) values ('${mem2}', 2, 2)`)
const prod = (await one(`insert into fl_products (workspace_id, name) values ($1, '100W') returning id`, [ws])).id

console.log('итог испытания по допускам')
const r = async m => (await one(`select fl_test_result($1::jsonb) as r`, [JSON.stringify(m)])).r
const P = (value, min = 95, max = 110) => ({ name: 'Мощность', unit: 'Вт', min, max, value })
assert.equal(await r([P(100)]), 'pass'); ok('в допуске — годен')
assert.equal(await r([P(90)]), 'fail'); ok('ниже минимума — брак')
assert.equal(await r([P(120)]), 'fail'); ok('выше максимума — брак')
assert.equal(await r([P(null)]), 'pending'); ok('нет значения — не закончено')
assert.equal(await r([P(null), P(90)]), 'fail'); ok('брак важнее незаконченного')
assert.equal(await r([{ name: 'КСВ', value: 1.2, min: null, max: 1.5 }]), 'pass'); ok('граница только сверху')
assert.equal(await r([]), 'pending'); ok('пустой протокол — не закончено')

console.log('запись испытаний от имени участника')
const t = await asAuth(async () => (await one(`insert into fl_tests (product_id, serial, measurements) values ($1, 'A-001', $2::jsonb) returning id, result, workspace_id, tester_id`,
  [prod, JSON.stringify([P(100), { name: 'КСВ', value: 1.9, min: null, max: 1.5 }])])))
assert.equal(t.result, 'fail'); assert.equal(t.workspace_id, ws); assert.equal(t.tester_id, u1); ok('итог «брак», workspace и испытатель проставлены')
const out = await one(`select text from fl_outbox where kind = 'test' and member_id = $1`, [mem2])
assert.match(out.text, /Брак на испытаниях: «100W», № A-001/); ok('уведомление о браке: ' + out.text)
await asAuth(() => db.query(`update fl_tests set measurements = $2::jsonb where id = $1`, [t.id, JSON.stringify([P(100), { name: 'КСВ', value: 1.3, min: null, max: 1.5 }])]))
assert.equal((await one(`select result from fl_tests where id = $1`, [t.id])).result, 'pass'); ok('исправили значение — стал «годен»')
const logs = (await db.query(`select action from ws_activity where entity_id = $1 order by created_at`, [prod])).rows.map(x => x.action)
assert.deepEqual(logs.filter(a => a.startsWith('test.')), ['test.fail', 'test.pass']); ok('в журнале изделия: test.fail, затем test.pass')

console.log('ревизии состава')
const rev = await asAuth(async () => (await one(`insert into fl_bom_revisions (product_id, label, lines, total_rub) values ($1, 'v1.0', $2::jsonb, 29020) returning id, workspace_id`,
  [prod, JSON.stringify([{ kind: 'component', ref_id: 'x', name: 'SMA', qty: 2, unit: 'шт', unit_rub: 320, total_rub: 640 }])])))
assert.equal(rev.workspace_id, ws); ok('ревизия создана, workspace проставлен')
await assert.rejects(asAuth(() => db.query(`update fl_bom_revisions set lines = '[]' where id = $1`, [rev.id])), /permission denied/); ok('снимок ревизии нельзя переписать')
await asAuth(() => db.query(`update fl_bom_revisions set label = 'v1.0 (серия)' where id = $1`, [rev.id]))
ok('подпись ревизии правится')
assert.ok((await db.query(`select 1 from ws_activity where action = 'bom.revision'`)).rows.length); ok('в журнале bom.revision')
console.log('\nпроверки качества пройдены')

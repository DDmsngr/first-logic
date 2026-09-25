import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1 } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
await db.exec(`grant usage on schema public to authenticated`)
const asAuth = (u, fn) => as(db, u, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })
const stock = async id => Number((await one(`select stock from fl_components where id = $1`, [id])).stock)

const C = async (name, stockQty, loc, extra = '') =>
  (await one(`insert into fl_components (workspace_id, name, stock, location ${extra ? ', ' + extra.split('=')[0] : ''}) values ($1, $2, $3, $4 ${extra ? ', ' + extra.split('=')[1] : ''}) returning id`, [ws, name, stockQty, loc])).id
const a = await C('Транзистор', 10, 'Шкаф 1')
const b = await C('Разъём', 42, 'Стеллаж 2')
const c = await C('Резистор', 500, 'Шкаф 1')
const arch = await C('Старый дроссель', 5, 'Шкаф 1', `archived_at=now()`)
const obs = await C('Снятый с производства', 7, 'Шкаф 1', `status='obsolete'`)

console.log('начало инвентаризации')
const st = (await asAuth(u1, () => one(`select fl_stocktake_start($1, null, null, 'Годовая') id`, [ws]))).id
let lines = (await db.query(`select name from fl_stocktake_lines where stocktake_id = $1 order by name`, [st])).rows.map(x => x.name)
assert.deepEqual(lines, ['Разъём', 'Резистор', 'Транзистор']); ok('в подсчёт попали активные, без архивных и снятых')
assert.equal((await one(`select num from fl_stocktakes where id = $1`, [st])).num, 1); ok('номер №1')
const st2 = (await asAuth(u1, () => one(`select fl_stocktake_start($1, null, 'шкаф 1') id`, [ws]))).id
assert.equal((await one(`select count(*)::int n from fl_stocktake_lines where stocktake_id = $1`, [st2])).n, 2); ok('фильтр по месту хранения, без учёта регистра')
assert.equal((await one(`select num from fl_stocktakes where id = $1`, [st2])).num, 2); ok('номер растёт: №2')
await assert.rejects(asAuth(u1, () => db.query(`select fl_stocktake_start($1, null, 'нет такого места')`, [ws])), /нет ни одного компонента/); ok('пустой отбор — понятная ошибка')
await assert.rejects(asAuth('00000000-0000-0000-0000-00000000dead', () => db.query(`select fl_stocktake_start($1)`, [ws])), /нет доступа/); ok('чужой пользователь начать не может')

console.log('подсчёт')
const lineId = async (stocktake, comp) => (await one(`select id from fl_stocktake_lines where stocktake_id = $1 and component_id = $2`, [stocktake, comp])).id
await asAuth(u1, async () => db.query(`update fl_stocktake_lines set counted = 8 where id = $1`, [await lineId(st, a)]))
await asAuth(u1, async () => db.query(`update fl_stocktake_lines set counted = 42 where id = $1`, [await lineId(st, b)]))
await assert.rejects(asAuth(u1, async () => db.query(`update fl_stocktake_lines set counted = -1 where id = $1`, [await lineId(st, c)])), /check/i); ok('отрицательный пересчёт нельзя')
await assert.rejects(asAuth(u1, async () => db.query(`update fl_stocktake_lines set expected = 999 where id = $1`, [await lineId(st, c)])), /permission denied/); ok('снимок «по учёту» править нельзя')

console.log('применение')
// пока считали, кто-то списал 3 транзистора: остаток теперь 7, а пересчитали 8
await db.query(`update fl_components set stock = 7 where id = $1`, [a])
const r = (await asAuth(u1, () => one(`select fl_stocktake_apply($1) r`, [st]))).r
assert.deepEqual(r, { changed: 1, same: 1, moved: 1 }); ok('изменён 1, совпал 1, «сдвинулся за время подсчёта» 1')
assert.equal(await stock(a), 8); ok('остаток транзистора стал равен пересчёту (сравнение с остатком «сейчас»)')
assert.equal(await stock(b), 42); assert.equal(await stock(c), 500); ok('совпавший и непосчитанный не тронуты')
const log = (await db.query(`select meta from ws_activity where entity_id = $1 and action = 'component.stock'`, [a])).rows.at(-1).meta
assert.equal(log.reason, 'Инвентаризация №1'); assert.equal(log.from, '7.000'); assert.equal(log.to, '8.000'); ok('в истории компонента: причина «Инвентаризация №1»')
assert.equal(Number((await one(`select applied_delta d from fl_stocktake_lines where id = $1`, [await lineId(st, a)])).d), 1); ok('записана фактическая разница +1')
assert.ok((await db.query(`select 1 from ws_activity where entity_id = $1 and action = 'stocktake.applied'`, [st])).rows.length); ok('в общей ленте одна запись об инвентаризации')
await assert.rejects(asAuth(u1, () => db.query(`select fl_stocktake_apply($1)`, [st])), /уже закрыта/); ok('повторно применить нельзя')
const upd = await asAuth(u1, async () => db.query(`update fl_stocktake_lines set counted = 1 where id = $1 returning id`, [await lineId(st, c)]))
assert.equal(upd.rows.length, 0); ok('после применения пересчёт не правится (RLS отсекает молча)')
await assert.rejects(asAuth(u1, () => db.query(`delete from fl_stocktakes where id = $1`, [st])), /./).catch(async () => null)
assert.equal((await db.query(`select 1 from fl_stocktakes where id = $1`, [st])).rows.length, 1); ok('применённую инвентаризацию не удалить')
await asAuth(u1, () => db.query(`delete from fl_stocktakes where id = $1`, [st2]))
assert.equal((await db.query(`select 1 from fl_stocktakes where id = $1`, [st2])).rows.length, 0); ok('черновик удаляется, строки уходят каскадом')
console.log('\nпроверки инвентаризации пройдены')

import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1 } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
await db.exec(`grant usage on schema public to authenticated`)
const asAuth = fn => as(db, u1, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })
const C = async (name, stock) => (await one(`insert into fl_components (workspace_id, name, stock) values ($1, $2, $3) returning id`, [ws, name, stock])).id
const T = await C('Транзистор', 100), R = await C('Разъём', 100)
const prod = (await one(`insert into fl_products (workspace_id, name, version) values ($1, 'Усилитель', 'v1') returning id`, [ws])).id
await db.exec(`insert into fl_bom_items (workspace_id, parent_product_id, component_id, qty) values ('${ws}', '${prod}', '${T}', 2), ('${ws}', '${prod}', '${R}', 4)`)
const reserved = async id => Number((await one(`select coalesce(sum(reserved), 0) r from fl_component_reserved where component_id = $1`, [id])).r)
const reserve = (u, note = '') => asAuth(() => one(`select fl_reserve($1, null, $2, $3) id`, [prod, u, note])).then(x => x.id)

console.log('резерв')
const r1 = await reserve(10, 'Заказ ООО «Радиосвязь»')
assert.equal(await reserved(T), 20); assert.equal(await reserved(R), 40); ok('под 10 усилителей: транзисторов 20, разъёмов 40')
assert.equal(Number((await one(`select stock from fl_components where id = $1`, [T])).stock), 100); ok('склад не тронут — резерв только пометка')
const r2 = await reserve(5)
assert.equal(await reserved(T), 30); ok('несколько резервов складываются')
await assert.rejects(asAuth(() => db.query(`select fl_reserve($1, null, 0)`, [prod])), /больше нуля/); ok('нулевое количество отклонено')
const empty = (await one(`insert into fl_products (workspace_id, name) values ($1, 'Пустое') returning id`, [ws])).id
await assert.rejects(asAuth(() => db.query(`select fl_reserve($1, null, 1)`, [empty])), /состав пуст/); ok('пустой состав — понятная ошибка')
await assert.rejects(as(db, '00000000-0000-0000-0000-00000000dead', () => db.query(`select fl_reserve($1, null, 1)`, [prod])), /нет доступа/); ok('чужой пользователь не резервирует')

console.log('снятие и сборка')
await asAuth(() => db.query(`select fl_reservation_release($1)`, [r2]))
assert.equal(await reserved(T), 20); ok('снятие резерва освобождает компоненты')
await assert.rejects(asAuth(() => db.query(`select fl_reservation_release($1)`, [r2])), /уже закрыт/); ok('повторно снять нельзя')
await asAuth(() => db.query(`select fl_build($1, null, 4, 'партия 1')`, [prod]))
assert.equal(await reserved(T), 12); assert.equal(await reserved(R), 24); ok('собрали 4 из 10 — резерв уменьшился до 6 шт: транзисторов 12, разъёмов 24')
assert.equal(Number((await one(`select units from fl_reservations where id = $1`, [r1])).units), 6); ok('в резерве осталось 6 изделий')
await asAuth(() => db.query(`select fl_build($1, null, 6, 'партия 2')`, [prod]))
assert.equal(await reserved(T), 0)
assert.equal((await one(`select status from fl_reservations where id = $1`, [r1])).status, 'fulfilled'); ok('собрали остаток — резерв выполнен и закрыт')
await asAuth(() => db.query(`select fl_build($1, null, 3, 'сверх резерва')`, [prod])); ok('сборка сверх резерва разрешена и ничего не ломает')

console.log('права')
await assert.rejects(asAuth(() => db.query(`insert into fl_reservations (workspace_id, product_id, title, units) values ($1, $2, 'x', 1)`, [ws, prod])), /permission denied/); ok('напрямую резерв не создать — только функцией')
assert.equal((await asAuth(() => db.query(`select 1 from fl_reservations`))).rows.length, 2); ok('участник видит резервы своего контура')
console.log('\nпроверки резервов пройдены')

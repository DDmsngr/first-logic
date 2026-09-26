import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1, u2 } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
await db.exec(`grant usage on schema public to authenticated`)
const asAuth = (u, fn) => as(db, u, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })
const p1 = (await one(`insert into fl_products (workspace_id, name, version, planned_price, actual_price, price_currency) values ($1, 'Усилитель 100W', 'v2', 150000, 145000, 'RUB') returning id`, [ws])).id
const p2 = (await one(`insert into fl_products (workspace_id, name, planned_price, price_currency) values ($1, 'Усилитель $', 2000, 'USD') returning id`, [ws])).id
const create = (items, cur = 'RUB', cust = 'ООО «Радиосвязь»') =>
  asAuth(u1, () => one(`select fl_co_create($1, $2, '+7 900', $3, null, 'срочно', $4::jsonb) id`, [ws, cust, cur, JSON.stringify(items)])).then(x => x.id)

console.log('создание')
const o1 = await create([{ product_id: p1, qty: 5 }, { product_id: p2, qty: 1, price: 1900 }])
const ord = await one(`select num, status, paid, created_by from fl_customer_orders where id = $1`, [o1])
assert.equal(ord.num, 1); assert.equal(ord.status, 'new'); assert.equal(Number(ord.paid), 0); assert.equal(ord.created_by, u1); ok('заказ №1, статус «новый», автор проставлен')
const items = (await db.query(`select name, qty, price from fl_customer_order_items where order_id = $1 order by position`, [o1])).rows
assert.equal(items[0].name, 'Усилитель 100W v2'); assert.equal(Number(items[0].price), 145000); ok('цена по умолчанию — фактическая из карточки изделия')
assert.equal(Number(items[1].price), 1900); ok('явная цена важнее карточной')
const o2 = await create([{ product_id: p2, qty: 1 }])
assert.equal((await one(`select num from fl_customer_orders where id = $1`, [o2])).num, 2); ok('номер растёт: №2')
assert.equal(Number((await one(`select price from fl_customer_order_items where order_id = $1`, [o2])).price), 0); ok('валюта карточки ≠ валюте заказа — цена 0, вписать руками')
await assert.rejects(create([]), /хотя бы одну/); ok('пустой заказ отклонён')
await assert.rejects(create([{ product_id: '00000000-0000-0000-0000-000000000000', qty: 1 }]), /не найдено/); ok('чужое изделие отклонено')
await assert.rejects(as(db, '00000000-0000-0000-0000-00000000dead', () => db.query(`select fl_co_create($1, 'x', '', 'RUB', null, '', '[]')`, [ws])), /нет доступа/); ok('чужой пользователь не создаёт')
assert.ok((await db.query(`select 1 from ws_activity where action = 'sale.created' and entity_id = $1`, [o1])).rows.length); ok('в ленте: sale.created')

console.log('статус, оплата, правка')
await asAuth(u2, () => db.query(`update fl_customer_orders set status = 'in_progress', paid = 72500.5 where id = $1`, [o1]))
const st = await one(`select status, paid from fl_customer_orders where id = $1`, [o1])
assert.equal(st.status, 'in_progress'); assert.equal(Number(st.paid), 72500.5); ok('участник меняет статус и оплату')
assert.ok((await db.query(`select 1 from ws_activity where action = 'sale.status' and entity_id = $1`, [o1])).rows.length); ok('смена статуса в ленте')
await assert.rejects(asAuth(u1, () => db.query(`update fl_customer_orders set num = 99 where id = $1`, [o1])), /permission denied/); ok('номер заказа править нельзя')
const upd = await asAuth(u1, () => db.query(`update fl_customer_order_items set qty = 6 where order_id = $1 returning id`, [o1]))
assert.equal(upd.rows.length, 0); ok('позиции заказа «в работе» уже не правятся')
await asAuth(u1, () => db.query(`update fl_customer_order_items set qty = 3 where order_id = $1 returning id`, [o2]))
assert.equal(Number((await one(`select qty from fl_customer_order_items where order_id = $1`, [o2])).qty), 3); ok('позиции нового заказа правятся')
await asAuth(u1, () => db.query(`insert into fl_customer_order_items (order_id, product_id, name, qty, price) values ($1, $2, 'Доп. позиция', 1, 10)`, [o2, p1]))
assert.equal((await one(`select count(*)::int n from fl_customer_order_items where order_id = $1`, [o2])).n, 2); ok('в новый заказ можно добавить позицию')

console.log('удаление')
const del1 = await asAuth(u1, () => db.query(`delete from fl_customer_orders where id = $1 returning id`, [o1]))
assert.equal(del1.rows.length, 0); ok('заказ в работе не удалить')
await asAuth(u1, () => db.query(`delete from fl_customer_orders where id = $1`, [o2]))
assert.equal((await db.query(`select 1 from fl_customer_orders where id = $1`, [o2])).rows.length, 0); ok('новый удаляется вместе с позициями')

console.log('экземпляры привязываются к заказу')
const T = (await one(`insert into fl_components (workspace_id, name, stock) values ($1, 'Т', 100) returning id`, [ws])).id
await db.exec(`insert into fl_bom_items (workspace_id, parent_product_id, component_id, qty) values ('${ws}', '${p1}', '${T}', 1)`)
await asAuth(u1, () => db.query(`select fl_build_serial($1, 1, '', ARRAY['S-1']::text[])`, [p1]))
await asAuth(u1, () => db.query(`update fl_units set status = 'shipped', customer = 'ООО «Радиосвязь»', order_id = $1 where serial = 'S-1'`, [o1]))
assert.equal((await one(`select order_id from fl_units where serial = 'S-1'`)).order_id, o1); ok('экземпляр отгружен по заказу №1')
await db.query(`update fl_customer_orders set status = 'cancelled' where id = $1`, [o1])
await db.query(`delete from fl_customer_orders where id = $1`, [o1])
assert.equal((await one(`select order_id from fl_units where serial = 'S-1'`)).order_id, null); ok('удаление заказа не удаляет экземпляр, только отвязывает')
console.log('\nпроверки заказов клиентов пройдены')

import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('uncaughtException', e => { console.error('ОШИБКА:', e.message, e.detail ?? '', e.where ?? ''); process.exit(1) })
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? '', e.where ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1, u2 } = await seed(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const one = async (sql, params) => (await q(sql, params))[0]
const ok = m => console.log('  ✓', m)

// второй участник привязал Telegram — ему придут уведомления о действиях первого
const mem2 = (await (await db.query(`select id from ws_members where user_id = $1`, [u2])).rows[0]).id
await db.exec(`insert into fl_tg_links (member_id, tg_user_id, tg_chat_id) values ('${mem2}', 2, 2)`)
await db.exec(`update fl_rates set cbr_rate = 12 where currency = 'CNY'; update fl_rates set cbr_rate = 80 where currency = 'USD'`)
const sup = (await one(`insert into fl_suppliers (workspace_id, name) values ($1, 'LCSC') returning id`, [ws])).id
const sup2 = (await one(`insert into fl_suppliers (workspace_id, name) values ($1, 'ЧИП и ДИП') returning id`, [ws])).id
const C = async (name, stock, price, cur = 'RUB') =>
  (await one(`insert into fl_components (workspace_id, name, stock, price, currency, supplier_id) values ($1,$2,$3,$4,$5,$6) returning id`,
    [ws, name, stock, price, cur, sup])).id
const R = await C('Резистор', 100, 1), T = await C('Транзистор', 5, 20, 'USD'), SMA = await C('SMA', 10, 300)
const asm = (await one(`insert into fl_assemblies (workspace_id, name) values ($1, 'Каскад') returning id`, [ws])).id
const prod = (await one(`insert into fl_products (workspace_id, name, version) values ($1, 'Усилитель', 'v1') returning id`, [ws])).id
await db.exec(`insert into fl_bom_items (workspace_id, parent_assembly_id, component_id, qty) values
  ('${ws}', '${asm}', '${R}', 4), ('${ws}', '${asm}', '${T}', 1);
  insert into fl_bom_items (workspace_id, parent_product_id, child_assembly_id, qty) values ('${ws}', '${prod}', '${asm}', 2);
  insert into fl_bom_items (workspace_id, parent_product_id, component_id, qty) values ('${ws}', '${prod}', '${SMA}', 2);`)

console.log('раскрытие состава')
const ex = Object.fromEntries((await q(`select component_id, qty::float from fl_explode($1, null, 3)`, [prod])).map(r => [r.component_id, r.qty]))
assert.equal(ex[R], 24); assert.equal(ex[T], 6); assert.equal(ex[SMA], 6); ok('3 изделия: резисторов 24, транзисторов 6, SMA 6')

console.log('сборка')
const build = await as(db, u1, async () => (await one(`select fl_build($1, null, 3, 'партия 1') as id`, [prod])).id)
const st = async id => Number((await one(`select stock from fl_components where id = $1`, [id])).stock)
assert.equal(await st(R), 76); assert.equal(await st(T), -1); assert.equal(await st(SMA), 4); ok('списано: 100→76, 5→−1 (в минус), 10→4')
const b = await one(`select title, qty::float, jsonb_array_length(lines) as n from fl_builds where id = $1`, [build])
assert.equal(b.title, 'Усилитель v1'); assert.equal(b.n, 3); ok('запись сборки: «Усилитель v1», 3 строки')
const logs = await q(`select action, meta from ws_activity where workspace_id = $1 order by created_at`, [ws])
const stockLogs = logs.filter(l => l.action === 'component.stock')
assert.equal(stockLogs.length, 3); assert.ok(stockLogs.every(l => l.meta.reason === 'Сборка: Усилитель v1 × 3')); ok('в истории компонентов причина «Сборка: Усилитель v1 × 3»')
assert.ok(logs.some(l => l.action === 'build.done' && l.meta.to === '3')); ok('в журнале одна строка build.done')

console.log('отмена сборки')
await as(db, u1, () => db.query(`select fl_build_revert($1)`, [build]))
assert.equal(await st(R), 100); assert.equal(await st(T), 5); assert.equal(await st(SMA), 10); ok('всё вернулось на склад')
await assert.rejects(as(db, u1, () => db.query(`select fl_build_revert($1)`, [build])), /уже отменена/); ok('повторная отмена запрещена')
const empty = (await one(`insert into fl_products (workspace_id, name) values ($1, 'Пустое') returning id`, [ws])).id
await assert.rejects(as(db, u1, () => db.query(`select fl_build($1, null, 1)`, [empty])), /состав пуст/); ok('пустой состав — ошибка')
const reasonAfter = await one(`select current_setting('fl.reason', true) as r`)
assert.ok(!reasonAfter.r); ok('fl.reason после операции сброшен')

console.log('предложения и заказ')
await db.exec(`insert into fl_component_offers (component_id, supplier_id, price, currency) values ('${T}', '${sup2}', 150, 'CNY')`)
const offWs = await one(`select workspace_id from fl_component_offers limit 1`)
assert.equal(offWs.workspace_id, ws); ok('workspace предложения проставлен триггером')
const po = await as(db, u1, async () => (await one(`select fl_po_create($1, $2, $3::jsonb, 'срочно', '2026-10-01') as id`,
  [ws, sup2, JSON.stringify([{ component_id: T, qty: 10 }, { component_id: SMA, qty: 5 }])])).id)
const po2 = await as(db, u1, async () => (await one(`select fl_po_create($1, $2, $3::jsonb) as id`, [ws, sup, JSON.stringify([{ component_id: R, qty: 50 }])])).id)
const nums = await q(`select num from fl_purchase_orders order by num`)
assert.deepEqual(nums.map(n => n.num), [1, 2]); ok('номера заказов 1 и 2')
const items = await q(`select name, qty::float, price::float, currency from fl_purchase_order_items where order_id = $1 order by position`, [po])
assert.deepEqual(items[0], { name: 'Транзистор', qty: 10, price: 150, currency: 'CNY' }); ok('цена транзистора взята из предложения ЧИП и ДИП: 150 CNY')
assert.deepEqual(items[1], { name: 'SMA', qty: 5, price: 300, currency: 'RUB' }); ok('у SMA предложения нет — цена из карточки: 300 RUB')

await as(db, u1, () => db.query(`select fl_po_set_status($1, 'ordered')`, [po]))
const sts = async id => (await one(`select status from fl_components where id = $1`, [id])).status
assert.equal(await sts(T), 'ordered'); ok('после отправки компоненты «Заказан»')

console.log('приёмка')
// транзисторов пришло 8 из 10
const it = await q(`select id, name from fl_purchase_order_items where order_id = $1 order by position`, [po])
const expId = await as(db, u1, async () => (await one(`select fl_po_receive($1, $2::jsonb) as id`,
  [po, JSON.stringify([{ item_id: it[0].id, qty: 8 }, { item_id: it[1].id, qty: 5 }])])).id)
assert.equal(await st(T), 13); assert.equal(await st(SMA), 15); ok('склад: транзисторов 5+8=13, SMA 10+5=15')
assert.equal(await sts(T), 'active'); ok('«Заказан» снят')
const tp = await one(`select price::float, currency from fl_components where id = $1`, [T])
assert.deepEqual(tp, { price: 150, currency: 'CNY' }); ok('цена транзистора обновлена до цены заказа 150 CNY')
const exp = await one(`select description, amount::float, currency, rate_rub::float, amount_rub::float, supplier_id from fl_expenses where id = $1`, [expId])
// две валюты → в рублях: 8×150×12 + 5×300 = 14400 + 1500 = 15900
assert.equal(exp.currency, 'RUB'); assert.equal(exp.amount, 15900); assert.equal(exp.supplier_id, sup2)
ok(`расход «${exp.description}»: ${exp.amount} ₽ (две валюты → в рублях)`)
const poRow = await one(`select status, expense_id from fl_purchase_orders where id = $1`, [po])
assert.equal(poRow.status, 'received'); assert.equal(poRow.expense_id, expId); ok('заказ «принят», расход привязан')
await assert.rejects(as(db, u1, () => db.query(`select fl_po_receive($1)`, [po])), /уже принят/); ok('повторная приёмка запрещена')

// один валюта → расход в ней; без строк → всё по заказу
const exp2 = await as(db, u1, async () => (await one(`select fl_po_receive($1) as id`, [po2])).id)
const e2 = await one(`select amount::float, currency from fl_expenses where id = $1`, [exp2])
assert.deepEqual(e2, { amount: 50, currency: 'RUB' }); assert.equal(await st(R), 150); ok('второй заказ целиком: +50 резисторов, расход 50 ₽')

console.log('сводка и права')
await db.exec(`update fl_components set min_stock = 20 where id = '${SMA}'`)
const mem = (await one(`select id from ws_members where user_id = $1`, [u1])).id
await db.exec(`insert into fl_tg_links (member_id, tg_user_id, tg_chat_id) values ('${mem}', 1, 1)`)
const tg = await q(`select * from fl_bot_digest_targets()`)
assert.equal(tg.length, 2); ok('сводку получат оба привязанных участника')
const dg = (await one(`select fl_bot_digest($1) as d`, [mem])).d
assert.equal(dg.low.length, 1); assert.equal(dg.low[0].name, 'SMA'); ok('в сводке «пора заказать»: SMA')
const out = await q(`select text from fl_outbox where kind = 'order' and member_id = $1`, [mem2])
assert.ok(out.length >= 1 && out[0].text.includes('Заказ №')); ok('уведомление о приёмке в очереди: ' + out[0].text)
const bb = (await one(`select fl_bot_build($1, $2, 1) as id`, [mem, prod])).id
assert.ok(bb); ok('бот: сборка от имени участника')
const creator = await one(`select created_by from fl_builds where id = $1`, [bb])
assert.equal(creator.created_by, u1); ok('автор сборки из бота — сам участник')

const stranger = '00000000-0000-0000-0000-0000000000ff'
await db.exec(`insert into auth.users (id, email) values ('${stranger}', 'z@x.ru')`)
await assert.rejects(as(db, stranger, () => db.query(`select fl_build($1, null, 1)`, [prod])), /нет доступа/); ok('чужой не может собирать')
const s = await one(`select fl_search_orders($1, '№2') as r`, [ws])
assert.equal(s.r[0].num, 2); ok('поиск заказа по «№2»')
console.log('\nвсе проверки 0014 пройдены')

console.log('права на заказы (RLS)')
const po3 = await as(db, u1, async () => (await one(`select fl_po_create($1, $2, $3::jsonb) as id`, [ws, sup, JSON.stringify([{ component_id: R, qty: 1 }])])).id)
await db.exec(`grant usage on schema public to authenticated`)
const asAuth = async (fn) => as(db, u1, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })
const delReceived = await asAuth(() => db.query(`delete from fl_purchase_orders where id = $1 returning id`, [po]))
assert.equal(delReceived.rows.length, 0); ok('принятый заказ удалить нельзя (RLS молча отсекает)')
const upd = await asAuth(() => db.query(`update fl_purchase_order_items set qty = 99 where order_id = $1 returning id`, [po]))
assert.equal(upd.rows.length, 0); ok('строки принятого заказа не правятся')
const upd3 = await asAuth(() => db.query(`update fl_purchase_order_items set qty = 3 where order_id = $1 returning id`, [po3]))
assert.equal(upd3.rows.length, 1); ok('строки черновика правятся')
const del3 = await asAuth(() => db.query(`delete from fl_purchase_orders where id = $1 returning id`, [po3]))
assert.equal(del3.rows.length, 1); ok('черновик удаляется')
console.log('\nпроверки прав пройдены')

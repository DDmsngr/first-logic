// Регрессия уже работающих функций: бот (0013), состав, расходы, импорт задач.
import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? '', e.where ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1, project } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
await db.exec(`grant usage on schema public to authenticated`)
const asAuth = fn => as(db, u1, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })
const mem = (await one(`select id from ws_members where user_id = $1`, [u1])).id
await db.exec(`update fl_rates set cbr_rate = 80 where currency = 'USD'`)

console.log('состав изделия от имени участника (как из браузера)')
const prod = await asAuth(async () => (await one(`insert into fl_products (workspace_id, name) values ($1, '100W') returning id`, [ws])).id)
const comp = await asAuth(async () => (await one(`insert into fl_components (workspace_id, name, price) values ($1, 'SMA', 300) returning id`, [ws])).id)
const asm = await asAuth(async () => (await one(`insert into fl_assemblies (workspace_id, name) values ($1, 'Каскад') returning id`, [ws])).id)
await asAuth(() => db.query(`insert into fl_bom_items (workspace_id, parent_product_id, component_id, qty) values ($1, $2, $3, 2)`, [ws, prod, comp]))
ok('компонент в изделие — добавляется (была ошибка, исправлена в 0014)')
await asAuth(() => db.query(`insert into fl_bom_items (workspace_id, parent_product_id, child_assembly_id, qty) values ($1, $2, $3, 1)`, [ws, prod, asm]))
await asAuth(() => db.query(`insert into fl_bom_items (workspace_id, parent_assembly_id, component_id, qty) values ($1, $2, $3, 4)`, [ws, asm, comp]))
ok('узел в изделие и компонент в узел — добавляются')
await assert.rejects(asAuth(() => db.query(`insert into fl_bom_items (workspace_id, parent_assembly_id, child_assembly_id, qty) values ($1, $2, $2, 1)`, [ws, asm])))
ok('узел в самого себя — запрещено')

console.log('команды бота')
const apply = async intent => (await one(`select fl_bot_apply($1, $2::jsonb) as r`, [mem, JSON.stringify(intent)])).r
const t = await apply({ intent: 'create_task', title: 'Купить SMA', priority: 'medium', product_id: prod, due_date: '2026-10-01' })
assert.ok(t.num >= 1); ok(`create_task → #${t.num}`)
const tr = await one(`select creator_id, product_id from ws_tasks where id = $1`, [t.id])
assert.equal(tr.creator_id, u1); assert.equal(tr.product_id, prod); ok('автор — участник, изделие привязано')
await apply({ intent: 'update_task', task_num: t.num, status: 'done' })
assert.equal((await one(`select status from ws_tasks where id = $1`, [t.id])).status, 'done'); ok('update_task → done')
const e = await apply({ intent: 'create_expense', description: 'Корпуса', amount: 100, currency: 'USD', product_id: prod })
const er = await one(`select amount_rub::float, source, created_by from fl_expenses where id = $1`, [e.id])
assert.deepEqual(er, { amount_rub: 8000, source: 'telegram', created_by: u1 }); ok('create_expense → 100 $ = 8000 ₽, source telegram')
await apply({ intent: 'stock_in', component_id: comp, qty: 5, price: 350 })
const cr = await one(`select stock::float, price::float from fl_components where id = $1`, [comp])
assert.deepEqual(cr, { stock: 5, price: 350 }); ok('stock_in → +5, цена 350')
const nc = await apply({ intent: 'create_component', name: 'BLF188XR', qty: 3, price: 185, currency: 'USD' })
assert.ok(nc.id); ok('create_component')
await apply({ intent: 'add_note', product_id: prod, text: 'радиатор согласовали' })
assert.match((await one(`select notes from fl_products where id = $1`, [prod])).notes, /радиатор согласовали/); ok('add_note')
await assert.rejects(apply({ intent: 'update_task', task_num: 9999, status: 'done' }), /не найдена/); ok('несуществующая задача — ошибка')

console.log('импорт задач и поиск')
const imp = await asAuth(async () => (await one(`select ws_import_tasks($1, $2::jsonb) as r`, [project, JSON.stringify([
  { title: 'Импорт 1', description: '', status: 'todo', priority: 'high', assignee_id: null, due_date: null, labels: ['закупка'] }])])).r)
assert.equal(imp.length, 1); ok('ws_import_tasks')
const s = await asAuth(async () => (await one(`select ws_search($1, 'SMA') as r`, [ws])).r)
assert.ok(s.components.length >= 1 && s.tasks.length >= 1); ok('поиск находит компонент и задачу')
console.log('\nрегрессия пройдена')

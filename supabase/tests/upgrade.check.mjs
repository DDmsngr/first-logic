// Накат новых миграций на базу, где уже есть данные: так будет на живой базе (не на пустой).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? ''); process.exit(1) })

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', 'migrations')
const ok = m => console.log('  ✓', m)

// база «как на бою» перед этим пакетом: миграции до 0018 включительно
const BASE = '0018_bot_free_tasks_files.sql'
if (!fs.existsSync(path.join(MIG, BASE))) { console.log('  (базовой миграции нет — проверка пропущена)'); process.exit(0) }
const db = await boot({ upTo: BASE })
const { ws, u1, u2, project } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]

// живые данные: компоненты, изделие с составом, задача, сборка, заказ поставщику, испытание, ревизия
const T = (await one(`insert into fl_components (workspace_id, name, stock, price) values ($1, 'Транзистор', 50, 100) returning id`, [ws])).id
const prod = (await one(`insert into fl_products (workspace_id, name, version, planned_price, price_currency) values ($1, 'Усилитель', 'v1', 150000, 'RUB') returning id`, [ws])).id
await db.exec(`insert into fl_bom_items (workspace_id, parent_product_id, component_id, qty) values ('${ws}', '${prod}', '${T}', 2)`)
await db.query(`insert into ws_tasks (workspace_id, project_id, title, creator_id) values ($1, $2, 'Старая задача', $3)`, [ws, project, u1])
await db.exec('grant usage on schema public to authenticated')
await as(db, u1, async () => { await db.exec('set role authenticated'); try { await db.query(`select fl_build($1, null, 3, 'до апгрейда')`, [prod]) } finally { await db.exec('reset role') } })
const before = { tasks: (await one(`select count(*)::int n from ws_tasks`)).n, builds: (await one(`select count(*)::int n from fl_builds`)).n, stock: Number((await one(`select stock from fl_components where id = $1`, [T])).stock) }
ok(`база на 0018 с данными: задач ${before.tasks}, сборок ${before.builds}, остаток ${before.stock}`)

// накатываем всё, что новее, по порядку — как это делает человек в SQL Editor
const newer = fs.readdirSync(MIG).filter(f => f.endsWith('.sql') && f > BASE).sort()
for (const f of newer) {
  const sql = fs.readFileSync(path.join(MIG, f), 'utf8').replace(/^create extension if not exists (http|pg_cron)[^;]*;/gim, '')
  try { await db.exec(sql) } catch (e) { console.error(`  ✗ ${f}: ${e.message}`); process.exit(1) }
  ok(`накатана ${f}`)
}
assert.ok(newer.length >= 6, 'ожидали миграции 0019–0024');

// данные на месте, новые возможности работают поверх старых данных
assert.equal((await one(`select count(*)::int n from ws_tasks`)).n, before.tasks); ok('задачи целы')
assert.equal((await one(`select count(*)::int n from fl_builds`)).n, before.builds); ok('старые сборки целы')
assert.equal(Number((await one(`select stock from fl_components where id = $1`, [T])).stock), before.stock); ok('остатки не изменились')
await as(db, u2, async () => { await db.exec('set role authenticated'); try {
  await db.query(`select fl_reserve($1, null, 2, 'после апгрейда')`, [prod])
  await db.query(`select fl_build_serial($1, 2, '', ARRAY['A-1','A-2']::text[])`, [prod])
  const co = (await db.query(`select fl_co_create($1, 'Клиент', '', 'RUB', null, '', $2::jsonb) id`, [ws, JSON.stringify([{ product_id: prod, qty: 1 }])])).rows[0].id
  assert.ok(co)
  const st = (await db.query(`select fl_stocktake_start($1) id`, [ws])).rows[0].id
  assert.ok(st)
} finally { await db.exec('reset role') } })
ok('резерв, сборка с номерами, заказ клиента и инвентаризация работают на старых данных')
console.log('\nпроверка наката пройдена')

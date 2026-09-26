import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1, u2, project } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
await db.exec(`grant usage on schema public to authenticated`)
const asAuth = (u, fn) => as(db, u, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })
const NO = /наблюдатель не может менять данные/

// участник-наблюдатель и данные для проверок
const u3 = '00000000-0000-0000-0000-0000000000a3'
await db.exec(`insert into auth.users (id, email) values ('${u3}', 'v@x.ru')`)
await db.exec(`insert into ws_members (workspace_id, user_id, email, name, role, status, joined_at) values ('${ws}', '${u3}', 'v@x.ru', 'Заказчик', 'viewer', 'active', now())`)
const comp = (await one(`insert into fl_components (workspace_id, name, stock) values ($1, 'Транзистор', 10) returning id`, [ws])).id
const prod = (await one(`insert into fl_products (workspace_id, name) values ($1, 'Усилитель') returning id`, [ws])).id
await db.exec(`insert into fl_bom_items (workspace_id, parent_product_id, component_id, qty) values ('${ws}', '${prod}', '${comp}', 1)`)
const task = (await one(`insert into ws_tasks (workspace_id, project_id, title, creator_id) values ($1, $2, 'Задача', $3) returning id`, [ws, project, u1])).id
const V = fn => asAuth(u3, fn)

console.log('наблюдатель читает')
assert.equal((await V(() => db.query(`select 1 from ws_tasks`))).rows.length, 1); ok('видит задачи')
assert.equal((await V(() => db.query(`select 1 from fl_components`))).rows.length, 1); ok('видит склад')
assert.equal((await V(() => db.query(`select 1 from fl_products`))).rows.length, 1); ok('видит изделия')

console.log('наблюдатель не пишет: прямые запросы (политики это разрешили бы обычному участнику)')
await assert.rejects(V(() => db.query(`insert into fl_components (workspace_id, name) values ($1, 'Взлом')`, [ws])), NO); ok('нельзя добавить компонент')
await assert.rejects(V(() => db.query(`update fl_components set stock = 999 where id = $1`, [comp])), NO); ok('нельзя поменять остаток')
await assert.rejects(V(() => db.query(`delete from fl_components where id = $1`, [comp])), NO); ok('нельзя удалить компонент')
await assert.rejects(V(() => db.query(`insert into fl_suppliers (workspace_id, name) values ($1, 'Поставщик')`, [ws])), NO); ok('нельзя добавить поставщика')
await assert.rejects(V(() => db.query(`insert into fl_expenses (workspace_id, description, amount, currency, rate_rub) values ($1, 'Трата', 100, 'RUB', 1)`, [ws])), NO); ok('нельзя записать расход')
await assert.rejects(V(() => db.query(`update ws_tasks set title = 'Чужое' where id = $1`, [task])), /наблюдатель не может|только задачи, назначенные на него/); ok('нельзя править задачу')
await assert.rejects(V(() => db.query(`insert into ws_comments (task_id, body) values ($1, 'привет')`, [task])), NO); ok('нельзя комментировать')
await assert.rejects(V(() => db.query(`update ws_workspaces set monthly_budget = 1 where id = $1`, [ws])), NO); ok('нельзя менять бюджет контура')
assert.equal(Number((await one(`select stock from fl_components where id = $1`, [comp])).stock), 10); ok('данные не изменились')

console.log('наблюдатель не пишет: функции с правами владельца')
await assert.rejects(V(() => db.query(`select fl_build($1, null, 1, '')`, [prod])), NO); ok('сборка со списанием')
await assert.rejects(V(() => db.query(`select fl_reserve($1, null, 1, '')`, [prod])), NO); ok('резерв')
await assert.rejects(V(() => db.query(`select fl_po_create($1, null, $2::jsonb)`, [ws, JSON.stringify([{ component_id: comp, qty: 1 }])])), NO); ok('заказ поставщику')
await assert.rejects(V(() => db.query(`select fl_stocktake_start($1)`, [ws])), NO); ok('инвентаризация')
await assert.rejects(V(() => db.query(`select fl_co_create($1, 'Клиент', '', 'RUB', null, '', $2::jsonb)`, [ws, JSON.stringify([{ product_id: prod, qty: 1 }])])), NO); ok('заказ клиента')
await assert.rejects(V(() => db.query(`select ws_claim_task($1)`, [task])), NO); ok('взять задачу')
// бот выполняет команды от имени участника через fl_bot_act_as — для наблюдателя это тоже отказ
const mem3 = (await one(`select id from ws_members where user_id = $1`, [u3])).id
await assert.rejects(db.query(`select fl_bot_apply($1, $2::jsonb)`, [mem3, JSON.stringify({ intent: 'create_task', title: 'Через бота' })]), NO); ok('создать задачу через бота')
await assert.rejects(db.query(`select fl_bot_apply($1, $2::jsonb)`, [mem3, JSON.stringify({ intent: 'stock_in', component_id: comp, qty: 5 })]), NO); ok('приход на склад через бота')
assert.equal((await one(`select count(*)::int n from ws_tasks`)).n, 1); assert.equal(Number((await one(`select stock from fl_components where id = $1`, [comp])).stock), 10); ok('после всех попыток ничего не изменилось')

console.log('наблюдатель может своё')
await V(() => db.query(`update ws_members set name = 'Заказчик Иванов', position = 'Менеджер' where user_id = $1`, [u3])); ok('профиль')
await V(() => db.query(`select ws_touch($1)`, [ws])); ok('отметка активности')
await db.query(`insert into ws_notifications (workspace_id, user_id, kind, title, link, dedupe) values ($1, $2, 'overdue', 'Тест', '/', 'd1')`, [ws, u3])
await V(() => db.query(`update ws_notifications set read_at = now() where user_id = $1`, [u3])); ok('прочитать уведомление')
await V(() => db.query(`select ws_sync_overdue($1)`, [ws])); ok('служебная проверка просрочек при открытии сайта')

console.log('обычный участник не задет')
await asAuth(u2, () => db.query(`insert into fl_components (workspace_id, name) values ($1, 'Разъём')`, [ws])); ok('админ добавляет компонент')
await asAuth(u2, () => db.query(`select fl_reserve($1, null, 1, '')`, [prod])); ok('и резервирует')

console.log('роль назначается и снимается')
await asAuth(u1, () => db.query(`update ws_members set role = 'viewer' where user_id = $1`, [u2]))
await assert.rejects(asAuth(u2, () => db.query(`insert into fl_components (workspace_id, name) values ($1, 'Ещё')`, [ws])), NO); ok('владелец сделал админа наблюдателем — запись закрылась')
await asAuth(u1, () => db.query(`update ws_members set role = 'admin' where user_id = $1`, [u2]))
await asAuth(u2, () => db.query(`insert into fl_components (workspace_id, name) values ($1, 'Ещё')`, [ws])); ok('вернули роль — запись открылась')
const tok = (await asAuth(u1, () => one(`select ws_invite_member($1, 'Подрядчик', 'p@x.ru', 'viewer') t`, [ws]))).t
assert.ok(tok); ok('можно пригласить наблюдателя')
await assert.rejects(asAuth(u1, () => db.query(`select ws_invite_member($1, 'X', 'x@x.ru', 'god')`, [ws])), /роль/); ok('несуществующая роль отклонена')

console.log('охват: у каждой таблицы с правом записи есть защита или она в списке личных данных')
const PERSONAL = new Set(['ws_members', 'ws_notifications', 'ws_invitations', 'ws_activity', 'fl_notify_prefs', 'fl_tg_links', 'fl_tg_link_codes', 'fl_tg_pending', 'fl_outbox', 'fl_rates'])
const rows = (await db.query(`
  select c.relname,
         exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'zzz_viewer_guard') as guarded
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE') or has_any_column_privilege('authenticated', c.oid, 'INSERT,UPDATE'))`)).rows
const naked = rows.filter(r => !r.guarded && !PERSONAL.has(r.relname)).map(r => r.relname)
assert.deepEqual(naked, [], 'таблицы с правом записи без защиты от наблюдателя (добавьте триггер или внесите в список личных данных): ' + naked.join(', '))
ok(`проверено таблиц: ${rows.length}, без защиты только личные данные`)
console.log('\nпроверки роли «наблюдатель» пройдены')

import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1 } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
await db.exec(`grant usage on schema public to authenticated`)
const asAuth = (u, fn) => as(db, u, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })
const A = fn => asAuth(u1, fn)

const comp1 = (await one(`insert into fl_components (workspace_id, name) values ($1, 'Транзистор') returning id`, [ws])).id
const comp2 = (await one(`insert into fl_components (workspace_id, name) values ($1, 'Разъём') returning id`, [ws])).id
const asm = (await one(`insert into fl_assemblies (workspace_id, name) values ($1, 'Блок питания') returning id`, [ws])).id
const prod = (await one(`insert into fl_products (workspace_id, name) values ($1, 'Усилитель') returning id`, [ws])).id
const task = (await one(`insert into ws_tasks (workspace_id, project_id, title, creator_id)
  values ($1, (select id from ws_projects where workspace_id = $1), 'Задача', $2) returning id`, [ws, u1])).id

const attach = (target, col) => A(() => one(
  `insert into ws_attachments (${col}, storage_path, filename, size, uploader_id) values ($1, $2, 'photo.jpg', 100, $3) returning id`,
  [target, `${ws}/${u1}/${crypto.randomUUID()}-photo.jpg`, u1]))

console.log('превью компонента')
const photo1 = (await attach(comp1, 'component_id')).id
await A(() => db.query(`update fl_components set preview_attachment_id = $1 where id = $2`, [photo1, comp1]))
assert.equal((await one(`select preview_attachment_id from fl_components where id = $1`, [comp1])).preview_attachment_id, photo1)
ok('своё фото ставится превью')

const photo2 = (await attach(comp2, 'component_id')).id
await assert.rejects(
  A(() => db.query(`update fl_components set preview_attachment_id = $1 where id = $2`, [photo2, comp1])),
  /превью должно быть файлом этого компонента/,
)
ok('чужое фото (другого компонента) отклонено')

const taskFile = (await attach(task, 'task_id')).id
await assert.rejects(
  A(() => db.query(`update fl_components set preview_attachment_id = $1 where id = $2`, [taskFile, comp1])),
  /превью должно быть файлом этого компонента/,
)
ok('файл задачи не подходит компоненту')

await A(() => db.query(`delete from ws_attachments where id = $1`, [photo1]))
assert.equal((await one(`select preview_attachment_id from fl_components where id = $1`, [comp1])).preview_attachment_id, null)
ok('удаление файла-превью сбрасывает ссылку (on delete set null)')

console.log('превью узла')
const asmPhoto = (await attach(asm, 'assembly_id')).id
await A(() => db.query(`update fl_assemblies set preview_attachment_id = $1 where id = $2`, [asmPhoto, asm]))
assert.equal((await one(`select preview_attachment_id from fl_assemblies where id = $1`, [asm])).preview_attachment_id, asmPhoto)
ok('своё фото ставится превью')
await assert.rejects(
  A(() => db.query(`update fl_assemblies set preview_attachment_id = $1 where id = $2`, [photo2, asm])),
  /превью должно быть файлом этого узла/,
)
ok('чужое фото отклонено')

console.log('превью изделия')
const prodPhoto = (await attach(prod, 'product_id')).id
await A(() => db.query(`update fl_products set preview_attachment_id = $1 where id = $2`, [prodPhoto, prod]))
assert.equal((await one(`select preview_attachment_id from fl_products where id = $1`, [prod])).preview_attachment_id, prodPhoto)
ok('своё фото ставится превью')
await assert.rejects(
  A(() => db.query(`update fl_products set preview_attachment_id = $1 where id = $2`, [photo2, prod])),
  /превью должно быть файлом этого изделия/,
)
ok('чужое фото отклонено')

console.log('наблюдатель')
const u3 = '00000000-0000-0000-0000-0000000000a3'
await db.exec(`insert into auth.users (id, email) values ('${u3}', 'v@x.ru')`)
await db.exec(`insert into ws_members (workspace_id, user_id, email, name, role, status, joined_at) values ('${ws}', '${u3}', 'v@x.ru', 'Заказчик', 'viewer', 'active', now())`)
await assert.rejects(
  asAuth(u3, () => db.query(`update fl_components set preview_attachment_id = $1 where id = $2`, [photo2, comp2])),
  /наблюдатель не может менять данные/,
)
ok('наблюдатель не может назначить превью')

console.log('очистка превью')
await A(() => db.query(`update fl_products set preview_attachment_id = null where id = $1`, [prod]))
assert.equal((await one(`select preview_attachment_id from fl_products where id = $1`, [prod])).preview_attachment_id, null)
ok('можно снять превью без удаления файла')
assert.equal((await one(`select count(*)::int n from ws_attachments where id = $1`, [prodPhoto])).n, 1)
ok('файл остался на месте')

console.log('\nпроверки превью пройдены')

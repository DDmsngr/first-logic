import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? '', e.where ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1, u2, project } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
await db.exec(`grant usage on schema public to authenticated`)
const asUser = (u, fn) => as(db, u, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })
const asOwner = fn => asUser(u1, fn)
const asAdmin2 = fn => asUser(u2, fn)

// участник без прав администратора — проверяем, что он может отмечать свои подзадачи,
// но не может создавать чек-листы и переструктурировать задачи
const u3 = '00000000-0000-0000-0000-0000000000a3'
await db.exec(`insert into auth.users (id, email) values ('${u3}', 'c@x.ru')`)
await db.exec(`insert into ws_members (workspace_id, user_id, email, name, role, status, joined_at) values ('${ws}', '${u3}', 'c@x.ru', 'Олег', 'member', 'active', now())`)
const asMember = fn => asUser(u3, fn)

const T = async title =>
  one(`insert into ws_tasks (workspace_id, project_id, title, creator_id) values ($1, $2, $3, $4) returning id, num`, [ws, project, title, u1])
const addSub = (parent, titles) => one(`select ws_task_add_subtasks($1, $2::text[]) r`, [parent, titles]).then(x => x.r)
const counts = async id => { const r = await one(`select subtask_total, subtask_done from ws_tasks where id = $1`, [id]); return { total: r.subtask_total, done: r.subtask_done } }

console.log('пакетное добавление подзадач')
const parent = await asOwner(() => T('Проверки перед отгрузкой 100W'))
const created = await asOwner(() => addSub(parent.id, ['Проверить КСВ', '  ', 'Проверить экранирование', 'Замерить мощность']))
assert.equal(created.length, 3); ok('пустая строка пропущена, создано 3 подзадачи')
assert.equal((await counts(parent.id)).total, 3); ok('счётчик родителя: total = 3')
assert.equal((await counts(parent.id)).done, 0); ok('done = 0 (все todo)')
const subs = (await db.query(`select id, num, status, parent_id, project_id, workspace_id from ws_tasks where parent_id = $1 order by created_at`, [parent.id])).rows
assert.equal(subs.length, 3); assert.ok(subs.every(s => s.project_id === project && s.workspace_id === ws)); ok('project/workspace унаследованы от родителя')

console.log('отмечать может назначенный, даже не админ')
const sub1 = subs[0]
await db.query(`update ws_tasks set assignee_id = $1 where id = $2`, [u3, sub1.id])
await asMember(() => db.query(`update ws_tasks set status = 'done' where id = $1`, [sub1.id]))
assert.equal((await one(`select status from ws_tasks where id = $1`, [sub1.id])).status, 'done'); ok('участник-исполнитель отметил свою подзадачу')
assert.deepEqual(await counts(parent.id), { total: 3, done: 1 }); ok('родитель пересчитан: 1 из 3 (без ошибки прав на родителя)')
await asMember(() => db.query(`update ws_tasks set status = 'todo' where id = $1`, [sub1.id]))
assert.deepEqual(await counts(parent.id), { total: 3, done: 0 }); ok('снял отметку — родитель пересчитан обратно')

console.log('чужую подзадачу участник не трогает')
const sub2 = subs[1]
await assert.rejects(asMember(() => db.query(`update ws_tasks set status = 'done' where id = $1`, [sub2.id])), /назначенные на него/); ok('не назначенную на себя подзадачу не отметить')
await assert.rejects(asMember(() => addSub(parent.id, ['Ещё проверка'])), /owner и admin/); ok('обычный участник чек-лист не пополняет')

console.log('глубина — только один уровень')
await assert.rejects(asOwner(() => addSub(sub1.id, ['Под-подзадача'])), /своих подзадач/); ok('у подзадачи нельзя завести свою подзадачу (через ws_task_add_subtasks)')
await assert.rejects(asOwner(() => db.query(`update ws_tasks set parent_id = $1 where id = $2`, [sub1.id, sub2.id])), /одного уровня/); ok('sub2 не отдать под sub1 — sub1 сам подзадача, второй уровень запрещён')
console.log('«у задачи уже есть подзадачи» — её саму не сделать чьей-то подзадачей')
const other = await asOwner(() => T('Другая задача'))
await assert.rejects(asOwner(() => db.query(`update ws_tasks set parent_id = $1 where id = $2`, [other.id, parent.id])), /уже есть подзадачи/); ok('родителя с подзадачами не прикрепить к другой задаче')
await assert.rejects(asOwner(() => db.query(`update ws_tasks set parent_id = $1 where id = $2`, [other.id, other.id])), /самой себе/); ok('задача не может быть подзадачей самой себе (без своих подзадач)')

console.log('прикрепить существующую задачу (как делает картина «куча задач → одна с чек-листом»)')
const stray1 = await asOwner(() => T('Проверить питание 28В'))
const stray2 = await asOwner(() => T('Проверить корпус на трещины'))
await asOwner(() => db.query(`update ws_tasks set parent_id = $1 where id in ($2, $3)`, [parent.id, stray1.id, stray2.id]))
assert.deepEqual(await counts(parent.id), { total: 5, done: 0 }); ok('две отдельные задачи стали подзадачами — total вырос до 5')

console.log('открепление')
await asOwner(() => db.query(`update ws_tasks set parent_id = null where id = $1`, [stray2.id]))
assert.deepEqual(await counts(parent.id), { total: 4, done: 0 }); ok('открепили — total вернулся к 4')
assert.equal((await one(`select parent_id from ws_tasks where id = $1`, [stray2.id])).parent_id, null)

console.log('архивная подзадача не считается')
await asOwner(() => db.query(`update ws_tasks set archived_at = now() where id = $1`, [stray1.id]))
assert.deepEqual(await counts(parent.id), { total: 3, done: 0 }); ok('заархивированная подзадача выпала из total')

console.log('удаление подзадачи пересчитывает родителя')
await db.query(`delete from ws_tasks where id = $1`, [subs[2].id])
assert.deepEqual(await counts(parent.id), { total: 2, done: 0 }); ok('удалили — total уменьшился')

console.log('cross-project запрещён')
const project2 = (await one(`insert into ws_projects (workspace_id, name, slug) values ($1, 'Второй проект', 'p2') returning id`, [ws])).id
const foreign = (await one(`insert into ws_tasks (workspace_id, project_id, title, creator_id) values ($1, $2, 'Чужой проект', $3) returning id`, [ws, project2, u1]))
await assert.rejects(asOwner(() => db.query(`update ws_tasks set parent_id = $1 where id = $2`, [parent.id, foreign.id])), /том же проекте/); ok('подзадача из другого проекта отклонена')

console.log('ws_project_stats и fl_bot_context не видят подзадачи как отдельные задачи')
const statsBefore = await one(`select ws_project_stats($1) s`, [project])
const totalTop = (await one(`select count(*)::int n from ws_tasks where project_id = $1 and parent_id is null and archived_at is null`, [project])).n
assert.equal(statsBefore.s.total, totalTop); ok(`ws_project_stats.total = ${totalTop} (только верхний уровень)`)

const mem3 = (await one(`select id from ws_members where user_id = $1`, [u3])).id
await db.exec(`insert into fl_tg_links (member_id, tg_user_id, tg_chat_id) values ('${mem3}', 3, 3)`)
await db.query(`update ws_tasks set assignee_id = null where id = $1`, [subs[0].id])
const ctx = await one(`select fl_bot_context(3) c`)
assert.ok(!ctx.c.free_tasks.some(t => t.num === subs[0].num)); ok('подзадача без исполнителя не попадает боту в «свободные»')
await db.query(`update ws_tasks set assignee_id = $1 where id = $2`, [u1, subs[0].id])
const ctx2 = await one(`select fl_bot_context(3) c`)
assert.ok(!ctx2.c.team_tasks.some(t => t.num === subs[0].num)); ok('и в «чужие занятые» тоже не попадает')
const memOwner = (await one(`select id from ws_members where user_id = $1`, [u1])).id
await db.exec(`insert into fl_tg_links (member_id, tg_user_id, tg_chat_id) values ('${memOwner}', 1, 1)`)
const ctxOwner = await one(`select fl_bot_context(1) c`)
assert.ok(ctxOwner.c.my_tasks.some(t => t.num === subs[0].num)); ok('а вот в «мои задачи» назначенная подзадача видна — не потеряется')

console.log('анонимный доступ закрыт')
await assert.rejects(db.exec(`set role anon; select ws_task_add_subtasks('${parent.id}', array['x'])`), /permission denied/)
await db.exec('reset role')
ok('ws_task_add_subtasks без входа — permission denied')

console.log('\nпроверки подзадач пройдены')

import assert from 'node:assert/strict'
import { boot, seed } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1, u2 } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
const mem1 = (await one(`select id from ws_members where user_id = $1`, [u1])).id
await db.exec(`insert into fl_tg_links (member_id, tg_user_id, tg_chat_id) values ('${mem1}', 1, 1)`)
const proj = (await one(`select id from ws_projects where workspace_id = $1 limit 1`, [ws])).id
const T = async (title, assignee) => (await one(`insert into ws_tasks (workspace_id, project_id, title, assignee_id, creator_id) values ($1, $2, $3, $4, $5) returning id`, [ws, proj, title, assignee, u1])).id

console.log('контекст бота: свободные и чужие задачи')
await T('Ничья задача', null)
await T('Моя задача', u1)
await T('Задача Ивана', u2)
const c = (await one(`select fl_bot_context(1) c`)).c
assert.deepEqual(c.free_tasks.map(t => t.title), ['Ничья задача']); ok('free_tasks — только без исполнителя')
assert.deepEqual(c.my_tasks.map(t => t.title), ['Моя задача']); ok('my_tasks не изменились')
assert.deepEqual(c.team_tasks.map(t => [t.title, t.assignee]), [['Задача Ивана', 'Иван']]); ok('team_tasks — с именем исполнителя')

console.log('файл из Telegram')
const task = await T('Разобрать таблицу', u1)
const path = `${ws}/${u1}/${crypto.randomUUID()}-табл.pdf`
const att = (await one(`select fl_bot_attach($1, $2, null, $3, 'табл.pdf', 'application/pdf', 1234) id`, [mem1, task, path])).id
const row = await one(`select task_id, uploader_id, workspace_id, filename from ws_attachments where id = $1`, [att])
assert.equal(row.task_id, task); assert.equal(row.uploader_id, u1); assert.equal(row.workspace_id, ws); ok('запись файла создана в задаче, автор — участник')
await assert.rejects(db.query(`select fl_bot_attach($1, $2, null, $3, 'x.pdf', null, 1)`, [mem1, task, `${ws}/${u2}/${crypto.randomUUID()}-x.pdf`]), /не совпадает/); ok('чужая папка в пути — отказ')
await assert.rejects(db.query(`select fl_bot_attach($1, null, null, $2, 'x.pdf', null, 1)`, [mem1, path + 'x']), /укажите/); ok('без цели — отказ')
console.log('\nпроверки бота (файлы) пройдены')

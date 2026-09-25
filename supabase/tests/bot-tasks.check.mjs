import assert from 'node:assert/strict'
import { boot, seed } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1, u2 } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
const mem = async u => (await one(`select id from ws_members where user_id = $1`, [u])).id
const m1 = await mem(u1), m2 = await mem(u2)
const proj = (await one(`select id from ws_projects where workspace_id = $1 limit 1`, [ws])).id
const T = async (title, assignee, status = 'todo') => (await one(`insert into ws_tasks (workspace_id, project_id, title, assignee_id, creator_id, status) values ($1, $2, $3, $4, $5, $6) returning id, num`, [ws, proj, title, assignee, u1, status]))
const act = (m, intent) => one(`select fl_bot_task_action($1, $2::jsonb) r`, [m, JSON.stringify(intent)]).then(x => x.r)

console.log('взять и отказаться')
const free = await T('Свободная', null)
const r = await act(m2, { intent: 'claim_task', task_num: free.num })
assert.equal(r.num, free.num); assert.equal(r.title, 'Свободная'); ok('ответ содержит номер и название')
const t = await one(`select assignee_id, status from ws_tasks where id = $1`, [free.id])
assert.equal(t.assignee_id, u2); assert.equal(t.status, 'in_progress'); ok('исполнитель — взявший, статус «в работе»')
await assert.rejects(act(m1, { intent: 'claim_task', task_num: free.num }), /уже взял/); ok('чужую занятую задачу взять нельзя')
await act(m2, { intent: 'release_task', task_num: free.num })
assert.equal((await one(`select assignee_id from ws_tasks where id = $1`, [free.id])).assignee_id, null); ok('отказ — задача снова свободна')
await assert.rejects(act(m1, { intent: 'claim_task', task_num: 99999 }), /не найдена/); ok('несуществующий номер — понятная ошибка')
const done = await T('Закрытая', null, 'done')
await assert.rejects(act(m1, { intent: 'claim_task', task_num: done.num }), /закрыта|уже взял/); ok('закрытую задачу не взять')

console.log('комментарий')
const mine = await T('Задача Ивана', u2)
await act(m1, { intent: 'add_comment', task_num: mine.num, text: 'Проверил КСВ, всё в норме' })
const c = await one(`select body, author_id from ws_comments where task_id = $1`, [mine.id])
assert.equal(c.body, 'Проверил КСВ, всё в норме'); assert.equal(c.author_id, u1); ok('комментарий записан от имени участника')
assert.ok((await db.query(`select 1 from ws_notifications where user_id = $1`, [u2])).rows.length); ok('исполнитель получил уведомление о комментарии')
await assert.rejects(act(m1, { intent: 'add_comment', task_num: mine.num, text: '   ' }), /пустой/); ok('пустой комментарий отклонён')
await assert.rejects(act(m1, { intent: 'nonsense', task_num: mine.num }), /неизвестное/); ok('неизвестное действие отклонено')
console.log('\nпроверки бота (задачи) пройдены')

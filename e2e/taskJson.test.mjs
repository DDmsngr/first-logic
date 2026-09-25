// Unit-тесты разбора JSON задач: node --test e2e/taskJson.test.mjs (Node 22.18+/24 читает .ts напрямую)
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTaskFile, resolveAssignee, buildExport, buildTemplate } from '../src/taskJson.ts'

const people = [
  { name: 'Алексей Евтушенко', email: '9254652@bk.ru', user_id: 'u-alex', status: 'active' },
  { name: 'Левон Согомонян', email: 'levon@bk.ru', user_id: 'u-levon', status: 'active' },
  { name: 'Алексей Петров', email: 'petrov@x.ru', user_id: 'u-petrov', status: 'active' },
  { name: 'Пригласили', email: 'inv@x.ru', user_id: null, status: 'invited' },
  { name: 'Стоп', email: 'stop@x.ru', user_id: 'u-stop', status: 'suspended' },
]

test('сценарий из задачи: две свободные и одна на Левона', () => {
  const file = JSON.stringify({ tasks: [
    { title: 'Раз' }, { title: 'Два', assignee: null }, { title: 'Три', assignee: 'Левон' },
  ] })
  const { rows, fatal } = parseTaskFile(file, people, [])
  assert.equal(fatal, undefined)
  assert.equal(rows.length, 3)
  assert.ok(rows.every(r => r.errors.length === 0))
  assert.deepEqual(rows.map(r => r.assigneeId), [null, null, 'u-levon'])
  assert.equal(rows[0].status, 'todo')
  assert.equal(rows[0].priority, 'medium')
})

test('исполнитель: email, полное имя, уникальная часть, регистр', () => {
  assert.equal(resolveAssignee('LEVON@bk.ru', people).id, 'u-levon')
  assert.equal(resolveAssignee('алексей евтушенко', people).id, 'u-alex')
  assert.equal(resolveAssignee('Евтушенко', people).id, 'u-alex')
  assert.equal(resolveAssignee('Согом', people).id, 'u-levon')
})

test('исполнитель: неоднозначно, нет такого, приглашённый и приостановленный не подходят', () => {
  assert.match(resolveAssignee('Алексей', people).error, /подходят/)
  assert.match(resolveAssignee('Иван', people).error, /нет в команде/)
  assert.match(resolveAssignee('inv@x.ru', people).error, /нет в команде/)
  assert.match(resolveAssignee('Стоп', people).error, /нет в команде/)
})

test('свободная задача: null, пусто, «свободна»', () => {
  for (const v of [null, undefined, '', 'free', 'Свободна', 'никому']) assert.equal(resolveAssignee(v, people).id, null)
  assert.equal(resolveAssignee(v => 1, people).error !== undefined, true)
})

test('корневой массив тоже принимается, алиасы статуса и приоритета', () => {
  const { rows } = parseTaskFile(JSON.stringify([{ title: 'A', status: 'В работе', priority: 'Критический' }, { title: 'B', status: 'in-progress' }]), people, [])
  assert.equal(rows[0].status, 'in_progress')
  assert.equal(rows[0].priority, 'critical')
  assert.equal(rows[1].status, 'in_progress')
})

test('ошибки: нет названия, плохой статус, приоритет, дата, метки', () => {
  const { rows } = parseTaskFile(JSON.stringify({ tasks: [
    { description: 'без названия' },
    { title: 'X', status: 'почти' },
    { title: 'Y', priority: 5 },
    { title: 'Z', due: '31.12.2026' },
    { title: 'W', due: '2026-02-31' },
    { title: 'V', labels: 'a, b' },
    { title: 'U', labels: [1] },
  ] }), people, [])
  assert.match(rows[0].errors[0], /нет названия/)
  assert.match(rows[1].errors[0], /status/)
  assert.match(rows[2].errors[0], /priority/)
  assert.match(rows[3].errors[0], /ГГГГ-ММ-ДД/)
  assert.match(rows[4].errors[0], /ГГГГ-ММ-ДД/)
  assert.deepEqual(rows[5].labels, ['a', 'b'])
  assert.match(rows[6].errors[0], /labels/)
})

test('дубликаты: против существующих и внутри файла', () => {
  const { rows } = parseTaskFile(JSON.stringify({ tasks: [{ title: 'Есть' }, { title: 'Новая' }, { title: 'новая ' }] }), people, ['ЕСТЬ'])
  assert.deepEqual(rows.map(r => r.duplicate), [true, false, true])
})

test('фатальные: не JSON, нет списка, пусто, слишком много', () => {
  assert.match(parseTaskFile('{oops', people, []).fatal, /JSON/)
  assert.match(parseTaskFile('{"a":1}', people, []).fatal, /нет списка/)
  assert.match(parseTaskFile('[]', people, []).fatal, /пуст/)
  assert.match(parseTaskFile(JSON.stringify(Array.from({ length: 201 }, (_, i) => ({ title: 't' + i }))), people, []).fatal, /200/)
})

test('BOM в начале файла не мешает; лишние поля — только предупреждение', () => {
  const { rows, fatal } = parseTaskFile('﻿' + JSON.stringify([{ title: 'A', foo: 1 }]), people, [])
  assert.equal(fatal, undefined)
  assert.equal(rows[0].errors.length, 0)
  assert.match(rows[0].warnings[0], /foo/)
})

test('круг: экспорт → разбор возвращает те же задачи', () => {
  const exp = buildExport(
    [{ num: 7, title: 'T', description: 'd', status: 'review', priority: 'high', assignee_id: 'u-levon', due_date: '2026-10-01', label_ids: ['l1'] }],
    people, id => (id === 'l1' ? 'карта' : undefined))
  const { rows } = parseTaskFile(JSON.stringify(exp), people, [])
  assert.equal(rows[0].errors.length, 0)
  assert.equal(rows[0].assigneeId, 'u-levon')
  assert.equal(rows[0].status, 'review')
  assert.equal(rows[0].due, '2026-10-01')
  assert.deepEqual(rows[0].labels, ['карта'])
})

test('шаблон сам проходит разбор без ошибок', () => {
  const { rows } = parseTaskFile(JSON.stringify(buildTemplate('9254652@bk.ru')), people, [])
  assert.equal(rows.length, 3)
  assert.ok(rows.every(r => r.errors.length === 0))
  assert.equal(rows[2].assigneeId, 'u-alex')
})

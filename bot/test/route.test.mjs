import test from 'node:test'
import assert from 'node:assert/strict'
import { isListenRequest, routeText } from '../src/route.ts'

const o = { username: 'first_logic_bot', botId: 111 }

test('в личке принимается всё', () => {
  assert.equal(routeText('private', '  Купить SMA ', o), 'Купить SMA')
})

test('в группе без обращения молчит', () => {
  assert.equal(routeText('supergroup', 'Ребят, кто едет на обед?', o), null)
})

test('упоминание в начале и в конце', () => {
  assert.equal(routeText('group', '@first_logic_bot купить 10 SMA для 100W', o), 'купить 10 SMA для 100W')
  assert.equal(routeText('supergroup', 'купить 10 SMA @First_Logic_Bot', o), 'купить 10 SMA')
})

test('ответ на сообщение бота — обращение', () => {
  assert.equal(routeText('supergroup', 'да, срочно', { ...o, replyToId: 111 }), 'да, срочно')
  assert.equal(routeText('supergroup', 'да, срочно', { ...o, replyToId: 222 }), null)
})

test('команды: своя проходит без суффикса, чужая игнорируется', () => {
  assert.equal(routeText('group', '/tasks@first_logic_bot', o), '/tasks')
  assert.equal(routeText('group', '/tasks', o), '/tasks')
  assert.equal(routeText('group', '/tasks@other_bot', o), null)
})

test('пустое после удаления упоминания — не команда', () => {
  assert.equal(routeText('group', '@first_logic_bot', o), null)
})

test('каналы и прочее не обрабатываются', () => {
  assert.equal(routeText('channel', '@first_logic_bot привет', o), null)
})

test('«слушай» — просьба разобрать голосовое, а не команда', () => {
  for (const t of ['слушай', 'Послушай', 'послушай это', 'расшифруй!', 'разбери голосовое', 'глянь', 'слушай, пожалуйста']) assert.equal(isListenRequest(t), true, t)
  for (const t of ['слушай, купи разъёмы', 'сделай задачу', 'слушайте все', '', 'разбери задачу #5']) assert.equal(isListenRequest(t), false, t)
})

test('в группе «@бот слушай» доходит до бота и очищается от упоминания', () => {
  assert.equal(routeText('supergroup', '@first_logic_bot слушай', o), 'слушай')
  assert.equal(isListenRequest(routeText('supergroup', '@first_logic_bot послушай', o)), true)
})

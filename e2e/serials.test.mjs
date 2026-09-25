import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSerials, serialRange, serialsProblem } from '../src/serials.ts'

test('список номеров: строки, запятые, пустое отбрасывается', () => {
  assert.deepEqual(parseSerials('A-1\nA-2, A-3;;  \nA-4'), ['A-1', 'A-2', 'A-3', 'A-4'])
  assert.deepEqual(parseSerials('  '), [])
})

test('ряд по образцу сохраняет ширину цифр', () => {
  assert.deepEqual(serialRange('FL100-0012', 3), ['FL100-0012', 'FL100-0013', 'FL100-0014'])
  assert.deepEqual(serialRange('FL-0098', 3), ['FL-0098', 'FL-0099', 'FL-0100'])
  assert.deepEqual(serialRange('7', 2), ['7', '8'])
  assert.deepEqual(serialRange('без цифр', 3), [])
  assert.deepEqual(serialRange('A-1', 0), [])
})

test('проверка списка: количество, дробное, повтор без учёта регистра', () => {
  assert.equal(serialsProblem([], 3), null)
  assert.equal(serialsProblem(['a', 'b'], 2), null)
  assert.match(serialsProblem(['a'], 2), /Номеров 1, а собрано 2/)
  assert.match(serialsProblem(['a', 'b'], 1.5), /целым/)
  assert.match(serialsProblem(['a', 'A'], 2), /повторяется/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { diffRevision, outOfRange, testResult } from '../src/quality.ts'

const M = (value, min = 95, max = 110) => ({ name: 'P', unit: 'Вт', min, max, value })

test('итог испытания совпадает с правилом базы', () => {
  assert.equal(testResult([M(100)]), 'pass')
  assert.equal(testResult([M(90)]), 'fail')
  assert.equal(testResult([M(null)]), 'pending')
  assert.equal(testResult([M(null), M(200)]), 'fail')
  assert.equal(testResult([]), 'pending')
  assert.equal(outOfRange({ name: 'КСВ', min: null, max: 1.5, value: 1.6 }), true)
  assert.equal(outOfRange({ name: 'КСВ', min: null, max: null, value: 99 }), false)
})

const L = (id, qty, unit_rub, kind = 'component') => ({ kind, ref_id: id, name: id, qty, unit: 'шт', unit_rub, total_rub: unit_rub === null ? null : unit_rub * qty })

test('сравнение ревизии с текущим составом', () => {
  const was = [L('SMA', 2, 300), L('T', 1, 15000), L('R', 10, 1)]
  const now = [L('SMA', 3, 300), L('T', 1, 16000), L('CASE', 1, 2000)]
  const d = diffRevision(was, now)
  assert.deepEqual(d.added.map(l => l.ref_id), ['CASE'])
  assert.deepEqual(d.removed.map(l => l.ref_id), ['R'])
  assert.deepEqual(d.changed.map(c => [c.now.ref_id, c.qty, c.price]), [['SMA', true, false], ['T', false, true]])
  assert.equal(d.totalWas, 600 + 15000 + 10)
  assert.equal(d.totalNow, 900 + 16000 + 2000)
})

test('копеечная разница цены от округления — не изменение', () => {
  const d = diffRevision([L('T', 1, 100.001)], [L('T', 1, 100.004)])
  assert.equal(d.changed.length, 0)
})

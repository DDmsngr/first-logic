import test from 'node:test'
import assert from 'node:assert/strict'
import { unitEconomics } from '../src/costing.ts'
import { byMonth, inRange, periodRange, sumBy } from '../src/finance.ts'

const P = (o = {}) => ({ manufacturing_cost: 0, additional_cost: 0, overhead_pct: 0, cost_override: null, ...o })

test('себестоимость по формуле и маржа', () => {
  // 29 020 + 5 000 + 1 000 + 10% × (29 020 + 5 000) = 38 422
  const u = unitEconomics(29020, P({ manufacturing_cost: 5000, additional_cost: 1000, overhead_pct: 10 }), 139000)
  assert.equal(Math.round(u.overhead), 3402)
  assert.equal(Math.round(u.total), 38422)
  assert.equal(Math.round(u.profit), 100578)
  assert.equal(u.margin.toFixed(1), '72.4')
})

test('ручная себестоимость перекрывает расчёт', () => {
  const u = unitEconomics(1000, P({ cost_override: 1500 }), 3000)
  assert.equal(u.calculated, 1000)
  assert.equal(u.total, 1500)
  assert.equal(u.profit, 1500)
  assert.equal(u.margin, 50)
  assert.equal(u.markup, 100)
})

test('без цены прибыли и маржи нет', () => {
  const u = unitEconomics(1000, P(), null)
  assert.equal(u.profit, null)
  assert.equal(u.margin, null)
})

test('периоды', () => {
  const d = new Date(2026, 8, 25)
  assert.deepEqual(periodRange('month', d), { from: '2026-09-01', to: '2026-09-30' })
  assert.deepEqual(periodRange('quarter', d), { from: '2026-07-01', to: '2026-09-30' })
  assert.equal(periodRange('all', d), null)
  assert.ok(inRange('2026-09-10', periodRange('month', d)))
  assert.ok(!inRange('2026-08-31', periodRange('month', d)))
})

const E = (spent_on, amount_rub, category_id = null, product_id = null) => ({ spent_on, amount_rub, category_id, product_id, supplier_id: null })

test('суммы по месяцам без дыр', () => {
  const r = byMonth([E('2026-07-03', 100), E('2026-09-10', 50), E('2026-09-20', 25)], null)
  assert.deepEqual(r, [{ month: '2026-07', sum: 100 }, { month: '2026-08', sum: 0 }, { month: '2026-09', sum: 75 }])
})

test('группировка по ключу, по убыванию', () => {
  const r = sumBy([E('2026-09-01', 10, 'a'), E('2026-09-01', 30, 'b'), E('2026-09-02', 5, 'a')], e => e.category_id)
  assert.deepEqual(r, [{ id: 'b', sum: 30 }, { id: 'a', sum: 15 }])
})

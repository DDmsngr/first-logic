import test from 'node:test'
import assert from 'node:assert/strict'
import { NEXT_STATUS, paymentState, saleMargin, saleTotal } from '../src/saleMath.ts'

test('сумма заказа округляется до копеек', () => {
  assert.equal(saleTotal([{ qty: 5, price: 145000 }, { qty: 1, price: 1900.5 }]), 726900.5)
  assert.equal(saleTotal([{ qty: 3, price: 0.1 }]), 0.3)
  assert.equal(saleTotal([]), 0)
})

test('оплата: не оплачен, частично, оплачен, переплата', () => {
  assert.deepEqual(paymentState(1000, 0), { state: 'unpaid', due: 1000 })
  assert.deepEqual(paymentState(1000, 400), { state: 'partial', due: 600 })
  assert.deepEqual(paymentState(1000, 1000), { state: 'paid', due: 0 })
  assert.deepEqual(paymentState(1000, 1200), { state: 'over', due: 0 })
  assert.deepEqual(paymentState(0, 0), { state: 'paid', due: 0 })
})

test('цепочка статусов заканчивается отгрузкой', () => {
  assert.equal(NEXT_STATUS.new, 'in_progress')
  assert.equal(NEXT_STATUS.ready, 'shipped')
  assert.equal(NEXT_STATUS.shipped, undefined)
  assert.equal(NEXT_STATUS.cancelled, undefined)
})

test('маржа считается только по позициям с известной себестоимостью', () => {
  const m = saleMargin(1000, [
    { qty: 2, unitCostRub: 100, revenueRub: 400 },
    { qty: 1, unitCostRub: null, revenueRub: 600 },
  ])
  assert.equal(m.cost, 200); assert.equal(m.profit, 200); assert.equal(m.missing, 1)
  assert.equal(Math.round(m.margin), 50)
  assert.equal(saleMargin(0, []).margin, null)
})

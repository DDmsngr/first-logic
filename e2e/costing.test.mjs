import test from 'node:test'
import assert from 'node:assert/strict'
import { createCosting, currencyShare, scaleRate } from '../src/costing.ts'

const rates = [{ currency: 'USD', cbr_rate: 80, cbr_date: null, fetched_at: null, manual_rate: null, updated_at: '' }]
const C = (id, price, currency = 'RUB', stock = 0) => ({ id, name: id, price, currency, unit: 'шт', stock })
let n = 0
const item = (parent, child, qty, extra = {}) => ({
  id: `i${++n}`, parent_product_id: parent.p ?? null, parent_assembly_id: parent.a ?? null,
  component_id: child.c ?? null, child_assembly_id: child.a ?? null, qty,
  price_override: null, price_currency: 'RUB', note: '', position: n, ...extra,
})

// PSU = 2×R(10₽) + 1×T($5)            → 20 + 400 = 420
// PA  = 1×PSU + 4×SMA(300₽)           → 420 + 1200 = 1620
// AMP = 1×PA + 1×CASE(2000₽) + 2×SMA  → 1620 + 2000 + 600 = 4220
const data = () => ({
  rates,
  components: [C('R', 10), C('T', 5, 'USD', 3), C('SMA', 300, 'RUB', 10), C('CASE', 2000)],
  assemblies: [{ id: 'PSU', name: 'PSU', cost_override: null }, { id: 'PA', name: 'PA', cost_override: null }],
  items: [
    item({ a: 'PSU' }, { c: 'R' }, 2), item({ a: 'PSU' }, { c: 'T' }, 1),
    item({ a: 'PA' }, { a: 'PSU' }, 1), item({ a: 'PA' }, { c: 'SMA' }, 4),
    item({ p: 'AMP' }, { a: 'PA' }, 1), item({ p: 'AMP' }, { c: 'CASE' }, 1), item({ p: 'AMP' }, { c: 'SMA' }, 2),
  ],
})

test('стоимость узла по составу, валюта по курсу', () => {
  assert.equal(createCosting(data()).assembly('PSU').total, 420)
})

test('вложенные узлы и изделие', () => {
  const k = createCosting(data())
  assert.equal(k.assembly('PA').total, 1620)
  assert.equal(k.product('AMP').total, 4220)
})

test('ручная цена узла перекрывает расчёт, расчёт тоже виден', () => {
  const d = data()
  d.assemblies[0].cost_override = 1000
  const psu = createCosting(d).assembly('PSU')
  assert.equal(psu.total, 1000)
  assert.equal(psu.calculated, 420)
  assert.equal(createCosting(d).product('AMP').total, 1000 + 1200 + 2000 + 600)
})

test('ручная цена в строке BOM', () => {
  const d = data()
  d.items.find(i => i.parent_product_id === 'AMP' && i.component_id === 'CASE').price_override = 1500
  assert.equal(createCosting(d).product('AMP').total, 3720)
})

test('нет курса — предупреждение, строка не считается', () => {
  const d = data()
  d.rates = []
  const psu = createCosting(d).assembly('PSU')
  assert.equal(psu.total, 20)
  assert.equal(psu.warnings[0].kind, 'no_rate')
})

test('цикл не вешает расчёт', () => {
  const d = data()
  d.items.push(item({ a: 'PSU' }, { a: 'PA' }, 1))
  const r = createCosting(d).product('AMP')
  assert.ok(r.warnings.some(w => w.kind === 'cycle'))
})

test('потребность на партию раскрывает узлы', () => {
  const need = createCosting(data()).explode({ productId: 'AMP' }, 10)
  assert.equal(need.get('R'), 20)
  assert.equal(need.get('T'), 10)
  assert.equal(need.get('SMA'), 60)
  assert.equal(need.get('CASE'), 10)
})

test('где используется и запрет на вложение в себя', () => {
  const k = createCosting(data())
  assert.equal(k.usedIn({ componentId: 'SMA' }).length, 2)
  assert.deepEqual([...k.ancestors('PSU')].sort(), ['PA', 'PSU'])
})


test('доля материалов по валютам', () => {
  const share = currencyShare(data(), { productId: 'AMP' })
  // T: 1 шт × $5 × 80 = 400 (через PA→PSU); RUB: R 20 + SMA 1200 + CASE 2000 + SMA 600 = 3820
  assert.equal(share.get('USD'), 400)
  assert.equal(share.get('RUB'), 3820)
})

test('если доллар +10% — материалы дорожают только на долларовую часть', () => {
  const d = data()
  const base = createCosting(d).product('AMP').total
  const up = createCosting({ ...d, rates: scaleRate(d.rates, 'USD', 10) }).product('AMP').total
  assert.equal(Math.round(up - base), 40)
})

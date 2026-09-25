import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOrder, orderTotals, purchaseOrderCsv, purchaseOrderRub, purchaseOrderText, toCsv, toText } from '../src/orders.ts'

const rates = [{ currency: 'CNY', cbr_rate: 11, cbr_date: null, fetched_at: null, manual_rate: null, updated_at: '' }]
const C = (id, name, stock, price, currency = 'RUB', supplier_id = null, extra = {}) =>
  ({ id, name, sku: null, manufacturer: null, supplier_id, url: null, unit: 'шт', price, currency, stock, ...extra })
const comps = [
  C('a', 'Разъём SMA', 3, 320, 'RUB', 's1', { sku: 'SMA-1' }),
  C('b', 'Радиатор', 1, 96, 'CNY', 's2'),
  C('c', 'Корпус', 40, 2450, 'RUB', 's1'),
  C('d', 'Кабель', 0, 0, 'RUB', null),
]
const sup = id => ({ s1: 'ЧИП и ДИП', s2: 'LCSC' }[id] ?? '')
// потребность на 10 комплектов
const need = new Map([['a', 20], ['b', 20], ['c', 10], ['d', 10]])
const all = { onlyShort: false, belowStock: null }

test('докупить = нужно − склад, не меньше нуля', () => {
  const rows = buildOrder(need, comps, sup, rates, { onlyShort: true, belowStock: null })
  const by = Object.fromEntries(rows.map(r => [r.comp.id, r.order]))
  assert.deepEqual(by, { a: 17, b: 19, d: 10 }) // корпус не нужен: на складе 40 при потребности 10
})

test('без фильтров в списке все позиции', () => {
  assert.equal(buildOrder(need, comps, sup, rates, all).length, 4)
})

test('фильтр «остаток меньше 5»', () => {
  const rows = buildOrder(need, comps, sup, rates, { onlyShort: false, belowStock: 5 })
  assert.deepEqual(rows.map(r => r.comp.id).sort(), ['a', 'b', 'd'])
})

test('сумма в рублях по курсу, без цены — null', () => {
  const rows = buildOrder(need, comps, sup, rates, { onlyShort: true, belowStock: null })
  const by = Object.fromEntries(rows.map(r => [r.comp.id, r.sumRub]))
  assert.equal(by.a, 17 * 320)
  assert.equal(by.b, 19 * 96 * 11)
  assert.equal(by.d, null)
  const t = orderTotals(rows)
  assert.equal(t.sumRub, 17 * 320 + 19 * 96 * 11)
  assert.equal(t.withoutPrice, 1)
})

test('сортировка: по поставщику, без поставщика в конце', () => {
  const rows = buildOrder(need, comps, sup, rates, { onlyShort: true, belowStock: null })
  assert.deepEqual(rows.map(r => r.supplier), ['ЧИП и ДИП', 'LCSC', ''].sort((x, y) => (!x !== !y ? (x ? -1 : 1) : x.localeCompare(y, 'ru'))))
  assert.equal(rows.at(-1).comp.id, 'd')
})

test('CSV: BOM, разделитель «;», десятичная запятая, кавычки', () => {
  const rows = buildOrder(new Map([['a', 20.5]]), [C('a', 'Разъём "SMA"; папа', 0, 12.5, 'RUB', 's1')], sup, rates, all)
  const csv = toCsv(rows, 'Заказ')
  assert.ok(csv.startsWith('﻿'))
  assert.match(csv, /"Разъём ""SMA""; папа"/)
  assert.match(csv, /;20,5;/)
  assert.match(csv, /ИТОГО/)
})

test('текст для мессенджера группируется по поставщику', () => {
  const t = toText(buildOrder(need, comps, sup, rates, { onlyShort: true, belowStock: null }), 'Заказ на 10 комплектов')
  assert.match(t, /— ЧИП и ДИП\nРазъём SMA \(SMA-1\): 17 шт/)
  assert.match(t, /— без поставщика\nКабель: 10 шт/)
})


test('документ заказа: итог по каждой валюте', () => {
  const lines = [
    { name: 'Радиатор', unit: 'шт', qty: 10, price: 96, currency: 'CNY' },
    { name: 'Корпус', unit: 'шт', qty: 2, price: 2450, currency: 'RUB', sku: 'AK-200' },
    { name: 'Кабель', unit: 'м', qty: 5, price: 0, currency: 'RUB' },
  ]
  const csv = purchaseOrderCsv('Заказ №3', lines)
  assert.match(csv, /ИТОГО;;;;CNY;960/)
  assert.match(csv, /ИТОГО;;;;RUB;4900/)
  assert.match(purchaseOrderText('Заказ №3', lines), /2\. Корпус \(AK-200\) — 2 шт/)
  const r = purchaseOrderRub(lines, rates)
  assert.equal(r.sum, 960 * 11 + 4900)
  assert.equal(r.unknown, 1)
})

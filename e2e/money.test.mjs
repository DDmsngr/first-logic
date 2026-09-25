import test from 'node:test'
import assert from 'node:assert/strict'
import { convert, effectiveRate, fmtMoney, parseAmount, toRub } from '../src/money.ts'

const rates = [
  { currency: 'USD', cbr_rate: 80, cbr_date: '2026-09-25', fetched_at: null, manual_rate: null, updated_at: '' },
  { currency: 'CNY', cbr_rate: 11, cbr_date: '2026-09-25', fetched_at: null, manual_rate: 12, updated_at: '' },
]

test('рубль всегда 1', () => {
  assert.equal(effectiveRate('RUB', []), 1)
  assert.equal(toRub(500, 'RUB', []), 500)
})

test('курс ЦБ, если ручного нет', () => {
  assert.equal(toRub(10, 'USD', rates), 800)
})

test('ручной курс перекрывает ЦБ', () => {
  assert.equal(effectiveRate('CNY', rates), 12)
  assert.equal(toRub(100, 'CNY', rates), 1200)
})

test('нет курса — null, а не ноль', () => {
  assert.equal(toRub(10, 'EUR', rates), null)
  assert.equal(convert(10, 'USD', 'EUR', rates), null)
})

test('перевод между валютами через рубль', () => {
  assert.equal(convert(12, 'CNY', 'USD', rates), 1.8)
  assert.equal(convert(800, 'RUB', 'USD', rates), 10)
})

test('разбор ручного ввода', () => {
  assert.equal(parseAmount('3 200,50'), 3200.5)
  assert.equal(parseAmount('3200.5'), 3200.5)
  assert.ok(Number.isNaN(parseAmount('')))
  assert.ok(Number.isNaN(parseAmount('abc')))
})

test('формат', () => {
  assert.equal(fmtMoney(null), '—')
  assert.match(fmtMoney(3200, 'RUB'), /^3\s200 ₽$/)
  assert.match(fmtMoney(12.5, 'USD'), /^12,50 \$$/)
})

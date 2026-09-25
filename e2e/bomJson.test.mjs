import test from 'node:test'
import assert from 'node:assert/strict'
import { normName, parseBomFile } from '../src/bomJson.ts'

const known = {
  components: [
    { id: 'c1', name: 'Транзистор BLF188XR', sku: 'BLF188XR' },
    { id: 'c2', name: 'Конденсатор 100 нФ, 0805', sku: null },
    { id: 'c3', name: 'Разъём SMA female', sku: 'SMA-KFD' },
  ],
  assemblies: [{ id: 'a1', name: 'Выходной каскад 100W', sku: null }],
}
const parse = (v, inBom = new Set()) => parseBomFile(typeof v === 'string' ? v : JSON.stringify(v), known, inBom)

test('нормализация названия', () => {
  assert.equal(normName('Конденсатор  100 нФ, 0805'), normName('конденсатор 100 нФ 0805'))
  assert.equal(normName('Ёмкость'), 'емкость')
})

test('сопоставление: артикул важнее названия, узлы тоже находятся', () => {
  const { rows } = parse({ items: [
    { name: 'Какой-то транзистор', sku: 'blf188xr', qty: 1 },
    { name: 'конденсатор 100 нФ 0805', qty: '12' },
    { name: 'Выходной каскад 100W', qty: 1 },
    { name: 'Новая деталь', qty: 3 },
  ] })
  assert.deepEqual(rows.map(r => r.match && [r.match.kind, r.match.id, r.match.by]), [
    ['component', 'c1', 'sku'], ['component', 'c2', 'name'], ['assembly', 'a1', 'name'], null,
  ])
  assert.equal(rows[1].qty, 12)
})

test('одна деталь несколькими строками — количества суммируются, обозначения склеиваются', () => {
  const { rows } = parse({ items: [
    { name: 'Конденсатор 100 нФ, 0805', qty: 2, note: 'C1, C2' },
    { name: 'конденсатор 100 нф 0805', qty: 3, note: 'C7-C9' },
  ] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].qty, 5)
  assert.equal(rows[0].merged, 2)
  assert.equal(rows[0].note, 'C1, C2, C7-C9')
})

test('уже в составе — отмечается', () => {
  const { rows } = parse({ items: [{ sku: 'SMA-KFD', qty: 2 }] }, new Set(['c3']))
  assert.equal(rows[0].inBom, true)
  assert.equal(rows[0].name, 'SMA-KFD')
})

test('ошибки: без количества, ноль, без названия', () => {
  const { rows } = parse({ items: [{ name: 'x' }, { name: 'y', qty: 0 }, { qty: 1 }] })
  assert.match(rows[0].errors[0], /нет количества/)
  assert.match(rows[1].errors[0], /не положительное/)
  assert.match(rows[2].errors[0], /нет названия/)
})

test('не JSON и пустое', () => {
  assert.ok(parse('привет').fatal)
  assert.ok(parse({ items: [] }).fatal)
  assert.equal(parse('```json\n{"items":[{"name":"a","qty":1}]}\n```').rows.length, 1)
})

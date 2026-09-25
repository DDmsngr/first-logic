import test from 'node:test'
import assert from 'node:assert/strict'
import { aiPrompt, buildTemplate, parseComponentFile, parseNumber } from '../src/componentJson.ts'

const known = {
  categories: [{ id: 'k1', name: 'Кабели' }, { id: 'k2', name: 'Разъёмы' }],
  suppliers: [{ id: 's1', name: 'LCSC' }],
  components: [{ id: 'c1', name: 'Разъём GX16M-8A', sku: 'GX16M-8A' }, { id: 'c2', name: 'Радиатор', sku: null }],
}
const parse = (v) => parseComponentFile(typeof v === 'string' ? v : JSON.stringify(v), known)

test('числа: запятая, пробелы, пусто', () => {
  assert.equal(parseNumber('188,00'), 188)
  assert.equal(parseNumber('1 200,5'), 1200.5)
  assert.equal(parseNumber(''), null)
  assert.equal(parseNumber(null), null)
  assert.ok(Number.isNaN(parseNumber('abc')))
})

test('строка из прайса: цена, валюта, категория, срок', () => {
  const { rows } = parse({ components: [{ name: 'Кабель GX16 (мама-папа) 50 метров', category: 'кабели', price: '188,00', currency: 'CNY', notes: 'Срок: two days' }] })
  const r = rows[0]
  assert.deepEqual(r.errors, [])
  assert.equal(r.price, 188)
  assert.equal(r.currency, 'CNY')
  assert.equal(r.categoryId, 'k1')
  assert.equal(r.notes, 'Срок: two days')
  assert.equal(r.duplicate, null)
})

test('без цены — строка годна, цена 0 и предупреждение', () => {
  const { rows } = parse({ components: [{ name: 'Герметичный переходник 9pin', price: null }] })
  assert.deepEqual(rows[0].errors, [])
  assert.equal(rows[0].priceGiven, false)
  assert.equal(rows[0].price, 0)
  assert.ok(rows[0].warnings.some(w => w.includes('цена не указана')))
})

test('ограда ```json и корневой массив', () => {
  const { rows } = parse('```json\n[{"name":"Радиатор 150"}]\n```')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'Радиатор 150')
})

test('валюта: символы и слова', () => {
  const cur = c => parse({ components: [{ name: 'x', price: 1, currency: c }] }).rows[0]
  assert.equal(cur('¥').currency, 'CNY')
  assert.equal(cur('$').currency, 'USD')
  assert.equal(cur('юаней').currency, 'CNY')
  assert.match(cur('фунты').errors[0], /валюта/)
})

test('нет названия и мусорная цена — ошибки', () => {
  const { rows } = parse({ components: [{ price: 5 }, { name: 'x', price: 'дорого' }] })
  assert.match(rows[0].errors[0], /нет названия/)
  assert.match(rows[1].errors[0], /не число/)
})

test('дубликаты: с базой по артикулу и названию, внутри файла', () => {
  const { rows } = parse({ components: [
    { name: 'Как-то иначе', sku: 'gx16m-8a' }, { name: 'радиатор' }, { name: 'Новый' }, { name: 'новый' },
  ] })
  assert.equal(rows[0].duplicate, 'db')
  assert.equal(rows[0].existingId, 'c1')
  assert.equal(rows[1].duplicate, 'db')
  assert.equal(rows[2].duplicate, null)
  assert.equal(rows[3].duplicate, 'file')
})

test('неизвестная категория — предупреждение, поставщик — новый', () => {
  const { rows } = parse({ components: [{ name: 'a', category: 'Волшебное', supplier: 'Taobao' }, { name: 'b', supplier: 'lcsc' }] })
  assert.equal(rows[0].categoryId, null)
  assert.ok(rows[0].warnings.some(w => w.includes('категория')))
  assert.equal(rows[0].newSupplier, true)
  assert.equal(rows[1].supplierId, 's1')
  assert.equal(rows[1].newSupplier, false)
})

test('остаток из «Кол-во» не подразумевается', () => {
  const { rows } = parse({ components: [{ name: 'a', price: 1, currency: 'RUB', qty: 8 }] })
  assert.equal(rows[0].stock, null)
})

test('пустое, не JSON, слишком много', () => {
  assert.ok(parse('привет').fatal)
  assert.ok(parse({ components: [] }).fatal)
  assert.ok(parse({ foo: 1 }).fatal)
  assert.ok(parse({ components: Array.from({ length: 501 }, (_, i) => ({ name: 'n' + i })) }).fatal)
})

test('шаблон разбирается без ошибок, подсказка содержит категории', () => {
  const t = parse(buildTemplate())
  assert.equal(t.rows.length, 3)
  assert.ok(t.rows.every(r => r.errors.length === 0))
  assert.match(aiPrompt(['Кабели', 'Разъёмы']), /"Кабели", "Разъёмы"/)
})

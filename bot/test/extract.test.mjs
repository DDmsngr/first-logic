import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExtractRequest, normalizeExtracted, parseExtractBody } from '../src/extract.ts'

test('ответ модели чистится: пустое, невалидные приоритет и дата, лишние метки', () => {
  const out = normalizeExtracted({ tasks: [
    { title: '  Проверить КСВ  ', description: 'на 144 МГц', priority: 'urgent', due: '31.12.2026', assignee: ' ', labels: ['a', 'b', 'c', 'd', ''] },
    { title: '', description: 'без названия' },
    { title: 'Заказать радиаторы', priority: 'high', due: '2026-10-05', assignee: 'Иван' },
    null,
  ] })
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { title: 'Проверить КСВ', description: 'на 144 МГц', labels: ['a', 'b', 'c'] })
  assert.deepEqual(out[1], { title: 'Заказать радиаторы', priority: 'high', due: '2026-10-05', assignee: 'Иван' })
  assert.deepEqual(normalizeExtracted(null), [])
  assert.deepEqual(normalizeExtracted({ tasks: 'нет' }), [])
})

test('не больше 40 задач', () => {
  const many = { tasks: Array.from({ length: 60 }, (_, i) => ({ title: `Задача ${i}` })) }
  assert.equal(normalizeExtracted(many).length, 40)
})

test('запрос к модели: PDF идёт файлом, текст — в промпте', () => {
  const pdf = JSON.parse(buildExtractRequest({ pdfBase64: 'QUJD' }, '2026-09-26', ['Иван']))
  assert.equal(pdf.contents[0].parts[1].inline_data.mime_type, 'application/pdf')
  assert.equal(pdf.contents[0].parts[1].inline_data.data, 'QUJD')
  const txt = JSON.parse(buildExtractRequest({ text: 'Проверить КСВ' }, '2026-09-26', ['Иван', 'Пётр']))
  assert.equal(txt.contents[0].parts.length, 1)
  assert.match(txt.contents[0].parts[0].text, /Проверить КСВ/)
  assert.match(txt.contents[0].parts[0].text, /Сегодня 2026-09-26/)
  assert.match(txt.contents[0].parts[0].text, /Иван, Пётр/)
})

test('проверка тела запроса: пустое, слишком большое, неизвестный тип', () => {
  assert.equal(parseExtractBody({ kind: 'text', text: '  ' }).ok, false)
  assert.equal(parseExtractBody({ kind: 'text', text: 'x'.repeat(200_001) }).status, 413)
  assert.equal(parseExtractBody({ kind: 'pdf', pdf_base64: 'A'.repeat(14_000_001) }).status, 413)
  assert.equal(parseExtractBody({ kind: 'pdf', pdf_base64: '<script>' }).ok, false)
  assert.equal(parseExtractBody({ kind: 'docx' }).ok, false)
  assert.equal(parseExtractBody(null).ok, false)
  const ok = parseExtractBody({ kind: 'text', text: 'Задача', people: ['Иван', 5] })
  assert.equal(ok.ok, true); assert.deepEqual(ok.people, ['Иван'])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import { docxToText, docxXmlToText } from '../src/docText.ts'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const p = t => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
const cell = t => `<w:tc>${p(t)}</w:tc>`

test('абзацы, таблицы, спецсимволы и переносы', () => {
  const xml = `<w:document ${W}><w:body>
    ${p('Замечания по покрытию')}
    <w:p><w:r><w:t>КСВ &lt; 1,5</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>&amp; мощность</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>${cell('Что')}${cell('Кто')}${cell('Срок')}</w:tr>
      <w:tr>${cell('Заказать радиаторы')}${cell('Иван')}${cell('05.10')}</w:tr>
    </w:tbl>
    ${p('Итог')}
  </w:body></w:document>`
  const text = docxXmlToText(xml)
  assert.equal(text, ['Замечания по покрытию', 'КСВ < 1,5\t& мощность', 'Что | Кто | Срок', 'Заказать радиаторы | Иван | 05.10', 'Итог'].join('\n'))
})

test('настоящий docx (zip): берётся word/document.xml, остальное игнорируется', () => {
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(`<w:document ${W}><w:body>${p('Проверить КСВ на 144 МГц')}</w:body></w:document>`),
    'word/styles.xml': strToU8('<w:styles/>'),
  })
  assert.equal(docxToText(zip), 'Проверить КСВ на 144 МГц')
})

test('не Word — понятная ошибка', () => {
  assert.throws(() => docxToText(zipSync({ 'a.txt': strToU8('x') })), /не документ Word/)
})

test('пустые строки в таблице не превращаются в разделители', () => {
  const xml = `<w:document ${W}><w:body><w:tbl><w:tr>${cell('')}${cell('')}</w:tr><w:tr>${cell('A')}${cell('')}</w:tr></w:tbl></w:body></w:document>`
  assert.equal(docxXmlToText(xml), 'A |')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { storageName } from '../src/fileName.ts'

test('имя файла для хранилища: только ASCII, кириллица транслитерируется', () => {
  assert.equal(storageName('фото-135.jpg'), 'foto-135.jpg')
  assert.equal(storageName('Таблица покрытия (финал).pdf'), 'Tablitsa_pokrytiya_final_.pdf')
  assert.equal(storageName('Щётка Ёжик.docx'), 'Schetka_Ezhik.docx')
  assert.equal(storageName('report v2 — копия.xlsx'), 'report_v2_kopiya.xlsx')
  assert.match(storageName('日本語.pdf'), /^[A-Za-z0-9._-]+$/)
  assert.equal(storageName('....'), 'file')
  assert.ok(storageName('а'.repeat(300) + '.pdf').length <= 120)
})

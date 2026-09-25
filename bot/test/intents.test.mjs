import test from 'node:test'
import assert from 'node:assert/strict'
import { canAttach, describe, needsConfirm, normalize } from '../src/intents.ts'

const ctx = {
  member: { id: 'm1', user_id: 'u1', name: 'Алексей', workspace_id: 'w1' },
  products: [{ id: 'p100', name: 'Усилитель 100W УКВ', version: 'v2.1', sku: 'FL-AMP-100' }],
  components: [{ id: 'c1', name: 'Транзистор BLF188XR', sku: 'BLF188XR', unit: 'шт', stock: 4, min_stock: 6, price: 185, currency: 'USD' }],
  suppliers: [{ id: 's1', name: 'ЧИП и ДИП' }],
  expense_categories: [{ id: 'e2', name: 'Производство' }],
  component_categories: [{ id: 'k1', name: 'Электроника' }],
  members: [{ user_id: 'u1', name: 'Алексей' }],
  my_tasks: [],
}
const esc = s => s

test('задача: normal → medium, изделие по id из контекста', () => {
  const { intent, missing } = normalize({ intent: 'create_task', confidence: 0.9, title: 'Купить 10 разъёмов SMA', priority: 'normal', product_id: 'p100' }, ctx)
  assert.deepEqual(missing, [])
  assert.equal(intent.priority, 'medium')
  assert.equal(intent.product_id, 'p100')
  assert.equal(needsConfirm(intent), false)
  assert.match(describe(intent, ctx, esc).join('\n'), /Изделие: Усилитель 100W УКВ v2.1/)
})

test('выдуманный id модели отбрасывается', () => {
  const { intent } = normalize({ intent: 'create_task', confidence: 0.9, title: 'x', product_id: 'nope' }, ctx)
  assert.equal(intent.product_id, undefined)
})

test('расход всегда через подтверждение, рубли по умолчанию', () => {
  const { intent, missing } = normalize({ intent: 'create_expense', confidence: 0.95, description: 'Корпуса для 200W', amount: '8500', category_id: 'e2' }, ctx)
  assert.deepEqual(missing, [])
  assert.equal(intent.amount, 8500)
  assert.equal(intent.currency, 'RUB')
  assert.equal(needsConfirm(intent), true)
})

test('приход на склад требует компонент из справочника', () => {
  const bad = normalize({ intent: 'stock_in', confidence: 0.9, qty: 5 }, ctx)
  assert.ok(bad.missing.includes('компонент из справочника'))
  const ok = normalize({ intent: 'stock_in', confidence: 0.9, component_id: 'c1', qty: 5, price: 3200 }, ctx)
  assert.deepEqual(ok.missing, [])
  assert.match(describe(ok.intent, ctx, esc).join('\n'), /Остаток станет: 9 шт/)
})

test('низкая уверенность — спросить даже задачу', () => {
  const { intent } = normalize({ intent: 'create_task', confidence: 0.4, title: 'что-то' }, ctx)
  assert.equal(needsConfirm(intent), true)
})

test('мусорные даты и статусы не проходят', () => {
  const { intent, missing } = normalize({ intent: 'update_task', confidence: 0.9, task_num: 12, status: 'готово', due_date: 'завтра' }, ctx)
  assert.equal(intent.status, undefined)
  assert.equal(intent.due_date, undefined)
  assert.ok(missing.includes('что изменить'))
})

test('сборка: изделие и количество из справочника, всегда через подтверждение', () => {
  const { intent, missing } = normalize({ intent: 'build', confidence: 0.95, product_id: 'p100', qty: 3 }, ctx)
  assert.deepEqual(missing, [])
  assert.equal(needsConfirm(intent), true)
  assert.match(describe(intent, ctx, esc).join('\n'), /Собрали «Усилитель 100W УКВ» v2\.1 × 3/)
  assert.ok(normalize({ intent: 'build', confidence: 0.9, qty: 3 }, ctx).missing.includes('изделие из справочника'))
})

test('файл из Telegram: прикрепляется только к задаче и заметке, виден в подтверждении', () => {
  assert.equal(canAttach({ intent: 'create_task' }), true)
  assert.equal(canAttach({ intent: 'add_note' }), true)
  assert.equal(canAttach({ intent: 'create_expense' }), false)
  const i = { intent: 'create_task', title: 'Разобрать таблицу', tg_file: { file_id: 'x', name: 'табл.pdf', mime: 'application/pdf', size: 10 } }
  assert.ok(describe(i, ctx, s => s).includes('📎 табл.pdf'))
})

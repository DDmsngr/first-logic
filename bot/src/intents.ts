// Команды бота: проверка того, что вернула модель, правило подтверждения и
// человеческое описание. Чистые функции — покрыты тестами (bot/test).

import type { Ctx } from './db'

export const INTENTS = [
  'create_task', 'update_task', 'create_expense', 'stock_in', 'stock_out', 'create_component',
  'create_product', 'create_assembly', 'add_note', 'build', 'query', 'unknown',
] as const
export type IntentKind = (typeof INTENTS)[number]

export interface Intent {
  intent: IntentKind
  confidence?: number
  title?: string; description?: string; priority?: string; due_date?: string; product_id?: string; assignee_user_id?: string
  task_num?: number; status?: string
  amount?: number; currency?: string; category_id?: string; supplier_id?: string; component_id?: string; spent_on?: string; note?: string
  qty?: number; price?: number; name?: string; sku?: string; unit?: string; version?: string; text?: string
  answer?: string; clarification?: string
}

const PRIORITY: Record<string, string> = { low: 'low', normal: 'medium', medium: 'medium', high: 'high', urgent: 'critical', critical: 'critical' }
const STATUS = ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done']
const CURRENCY = ['RUB', 'USD', 'CNY', 'EUR']
const DATE = /^\d{4}-\d{2}-\d{2}$/

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(',', '.'))) ? Number(v.replace(',', '.')) : undefined)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * Чистит ответ модели: выбрасывает пустое, id — только из контекста (модель
 * не может сослаться на выдуманную запись), числа и даты — только валидные.
 * Возвращает команду и список того, чего не хватает для выполнения.
 */
export function normalize(raw: Record<string, unknown>, ctx: Ctx): { intent: Intent; missing: string[] } {
  const kind = (INTENTS as readonly string[]).includes(String(raw.intent)) ? raw.intent as IntentKind : 'unknown'
  const idIn = (list: { id: string }[], v: unknown) => (typeof v === 'string' && list.some(x => x.id === v) ? v : undefined)
  const i: Intent = {
    intent: kind,
    confidence: Math.max(0, Math.min(1, num(raw.confidence) ?? 0.5)),
    title: str(raw.title), description: str(raw.description), text: str(raw.text), note: str(raw.note),
    name: str(raw.name), sku: str(raw.sku), unit: str(raw.unit), version: str(raw.version),
    priority: PRIORITY[String(raw.priority ?? '').toLowerCase()],
    status: STATUS.includes(String(raw.status)) ? String(raw.status) : undefined,
    due_date: DATE.test(String(raw.due_date)) ? String(raw.due_date) : undefined,
    spent_on: DATE.test(String(raw.spent_on)) ? String(raw.spent_on) : undefined,
    currency: CURRENCY.includes(String(raw.currency).toUpperCase()) ? String(raw.currency).toUpperCase() : undefined,
    amount: num(raw.amount), qty: num(raw.qty), price: num(raw.price), task_num: num(raw.task_num),
    product_id: idIn(ctx.products, raw.product_id),
    component_id: idIn(ctx.components, raw.component_id),
    supplier_id: idIn(ctx.suppliers, raw.supplier_id),
    category_id: idIn(kind === 'create_component' ? ctx.component_categories : ctx.expense_categories, raw.category_id),
    assignee_user_id: typeof raw.assignee_user_id === 'string' && ctx.members.some(m => m.user_id === raw.assignee_user_id) ? raw.assignee_user_id : undefined,
    answer: str(raw.answer), clarification: str(raw.clarification),
  }
  for (const k of Object.keys(i) as (keyof Intent)[]) if (i[k] === undefined) delete i[k]

  const missing: string[] = []
  const need = (ok: unknown, what: string) => { if (!ok) missing.push(what) }
  switch (kind) {
    case 'create_task': need(i.title, 'название задачи'); break
    case 'update_task': need(i.task_num, 'номер задачи'); need(i.status || i.due_date, 'что изменить'); break
    case 'create_expense': need(i.description, 'описание'); need(i.amount && i.amount > 0, 'сумму'); break
    case 'stock_in': case 'stock_out': need(i.component_id, 'компонент из справочника'); need(i.qty && i.qty > 0, 'количество'); break
    case 'create_component': need(i.name, 'название компонента'); break
    case 'create_product': case 'create_assembly': need(i.name, 'название'); break
    case 'add_note': need(i.product_id, 'изделие'); need(i.text, 'текст заметки'); break
    case 'build': need(i.product_id, 'изделие из справочника'); need(i.qty && i.qty > 0, 'сколько собрали'); break
  }
  if (i.amount !== undefined && !i.currency) i.currency = 'RUB'
  if (i.price !== undefined && !i.currency) i.currency = 'RUB'
  return { intent: i, missing }
}

/**
 * Деньги, склад и новые записи справочников — только после «Создать».
 * Задачи и заметки — сразу, если модель уверена.
 */
export function needsConfirm(i: Intent) {
  if (['create_expense', 'stock_in', 'stock_out', 'create_component', 'create_product', 'create_assembly', 'build'].includes(i.intent)) return true
  return (i.confidence ?? 0) < 0.75
}

const PR: Record<string, string> = { low: 'низкий', medium: 'обычный', high: 'высокий', critical: 'критичный' }
const ST: Record<string, string> = { backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress', review: 'Review', blocked: 'Blocked', done: 'Done' }
const SIGN: Record<string, string> = { RUB: '₽', USD: '$', CNY: '¥', EUR: '€' }

export const money = (n: number | undefined, cur = 'RUB') =>
  n === undefined ? '—' : `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${SIGN[cur] ?? cur}`
const fmtDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })

/** Что бот собирается сделать / сделал — строками для сообщения. */
export function describe(i: Intent, ctx: Ctx, esc: (s: string) => string): string[] {
  const product = ctx.products.find(p => p.id === i.product_id)
  const comp = ctx.components.find(c => c.id === i.component_id)
  const sup = ctx.suppliers.find(s => s.id === i.supplier_id)
  const cat = [...ctx.expense_categories, ...ctx.component_categories].find(c => c.id === i.category_id)
  const who = ctx.members.find(m => m.user_id === i.assignee_user_id)
  const q = (s: string) => `«${esc(s)}»`
  const out: string[] = []
  switch (i.intent) {
    case 'create_task':
      out.push(`Задача ${q(i.title!)}`, `Приоритет: ${PR[i.priority ?? 'medium']}`)
      if (i.due_date) out.push(`Срок: ${fmtDate(i.due_date)}`)
      if (who) out.push(`Исполнитель: ${esc(who.name)}`)
      break
    case 'update_task':
      out.push(`Задача #${i.task_num}`)
      if (i.status) out.push(`Статус → ${ST[i.status]}`)
      if (i.due_date) out.push(`Срок → ${fmtDate(i.due_date)}`)
      break
    case 'create_expense':
      out.push(`Расход ${money(i.amount, i.currency)} — ${q(i.description!)}`)
      if (cat) out.push(`Категория: ${esc(cat.name)}`)
      if (sup) out.push(`Поставщик: ${esc(sup.name)}`)
      if (i.spent_on) out.push(`Дата: ${fmtDate(i.spent_on)}`)
      break
    case 'stock_in': case 'stock_out':
      out.push(`${i.intent === 'stock_in' ? 'Приход' : 'Расход со склада'}: ${q(comp!.name)} ${i.intent === 'stock_in' ? '+' : '−'}${i.qty} ${esc(comp!.unit)}`,
        `Остаток станет: ${comp!.stock + (i.intent === 'stock_in' ? 1 : -1) * i.qty!} ${esc(comp!.unit)}`)
      if (i.price !== undefined) out.push(`Цена за ${esc(comp!.unit)}: ${money(comp!.price, comp!.currency)} → ${money(i.price, i.currency)}`)
      break
    case 'create_component':
      out.push(`Новый компонент ${q(i.name!)}`)
      if (i.qty) out.push(`На складе: ${i.qty} ${esc(i.unit ?? 'шт')}`)
      if (i.price !== undefined) out.push(`Цена: ${money(i.price, i.currency)}`)
      if (cat) out.push(`Категория: ${esc(cat.name)}`)
      break
    case 'create_product': out.push(`Новое изделие ${q(i.name!)}${i.version ? ` ${esc(i.version)}` : ''}`); break
    case 'create_assembly': out.push(`Новый узел ${q(i.name!)}`); break
    case 'add_note': out.push(`Заметка в изделие ${q(product!.name)}:`, esc(i.text!)); break
    case 'build': out.push(`Собрали ${q(product!.name)}${product!.version ? ` ${esc(product!.version)}` : ''} × ${i.qty}`, 'Компоненты по составу спишутся со склада'); break
  }
  if (product && i.intent !== 'add_note' && i.intent !== 'build') out.push(`Изделие: ${esc(product.name)}${product.version ? ` ${esc(product.version)}` : ''}`)
  return out
}

export const DONE_TITLE: Partial<Record<IntentKind, string>> = {
  create_task: '✅ Создал задачу', update_task: '✅ Обновил задачу', create_expense: '✅ Записал расход',
  stock_in: '✅ Оприходовал', stock_out: '✅ Списал со склада', create_component: '✅ Добавил компонент',
  create_product: '✅ Добавил изделие', create_assembly: '✅ Добавил узел', add_note: '✅ Добавил заметку',
  build: '✅ Списал со склада',
}

export const ASK_TITLE: Partial<Record<IntentKind, string>> = {
  create_task: 'Создать задачу?', update_task: 'Обновить задачу?', create_expense: 'Записать расход?',
  stock_in: 'Оприходовать?', stock_out: 'Списать со склада?', create_component: 'Добавить компонент?',
  create_product: 'Добавить изделие?', create_assembly: 'Добавить узел?', add_note: 'Добавить заметку?',
  build: 'Списать по сборке?',
}

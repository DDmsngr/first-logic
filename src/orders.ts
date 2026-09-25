// Список для заказа: чего и сколько докупить, чтобы собрать N комплектов.
// Чистые функции: расчёт строк, CSV для Excel и текст для мессенджера.

import { toRub, type Currency, type Rate } from './money.ts'

export interface OrderComponent {
  id: string
  name: string
  sku: string | null
  manufacturer: string | null
  supplier_id: string | null
  url: string | null
  unit: string
  price: number
  currency: Currency
  stock: number
}

export interface OrderRow {
  comp: OrderComponent
  supplier: string
  /** нужно на все комплекты */
  need: number
  /** на складе (минус не считаем) */
  stock: number
  /** докупить */
  order: number
  /** сумма заказа в рублях; null — нет цены или курса */
  sumRub: number | null
}

export interface OrderOpts {
  /** только то, чего не хватает для сборки */
  onlyShort: boolean
  /** только позиции, у которых на складе меньше N; null — не фильтровать */
  belowStock: number | null
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * need — потребность на всю партию (из costing.explode). Строки сортируются по
 * поставщику (без поставщика — в конце), затем по названию.
 */
export function buildOrder(
  need: Map<string, number>, components: OrderComponent[], supplierName: (id: string | null) => string,
  rates: Rate[], opts: OrderOpts,
): OrderRow[] {
  const byId = new Map(components.map(c => [c.id, c]))
  const rows: OrderRow[] = []
  for (const [id, q] of need) {
    const comp = byId.get(id)
    if (!comp) continue
    const stock = Math.max(comp.stock, 0)
    const order = Math.max(0, round3(q - stock))
    if (opts.onlyShort && order <= 0) continue
    if (opts.belowStock !== null && !(stock < opts.belowStock)) continue
    const unit = comp.price > 0 ? toRub(comp.price, comp.currency, rates) : null
    rows.push({ comp, supplier: supplierName(comp.supplier_id), need: round3(q), stock, order, sumRub: unit === null ? null : round3(unit * order) })
  }
  return rows.sort((a, b) => {
    if (!a.supplier !== !b.supplier) return a.supplier ? -1 : 1
    return a.supplier.localeCompare(b.supplier, 'ru') || a.comp.name.localeCompare(b.comp.name, 'ru')
  })
}

export function orderTotals(rows: OrderRow[]) {
  return {
    positions: rows.length,
    sumRub: rows.reduce((s, r) => s + (r.sumRub ?? 0), 0),
    withoutPrice: rows.filter(r => r.order > 0 && r.sumRub === null).length,
  }
}

// ── CSV для Excel ───────────────────────────────────────────────────────────
// Разделитель «;», десятичная запятая, UTF-8 с BOM: так русский Excel открывает без «кракозябр».

const cell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? '' : typeof v === 'number' ? String(v).replace('.', ',') : v
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: OrderRow[], title: string): string {
  const head = ['№', 'Артикул', 'Наименование', 'Поставщик', 'Нужно', 'На складе', 'Заказать', 'Ед.', 'Цена', 'Валюта', 'Сумма, руб', 'Ссылка']
  const lines: (string | number)[][] = [[title], [], head]
  rows.forEach((r, i) => lines.push([
    i + 1, r.comp.sku ?? '', r.comp.name, r.supplier, r.need, r.stock, r.order, r.comp.unit,
    r.comp.price > 0 ? r.comp.price : '', r.comp.price > 0 ? r.comp.currency : '', r.sumRub ?? '', r.comp.url ?? '',
  ]))
  const t = orderTotals(rows)
  lines.push([], ['', '', 'ИТОГО', '', '', '', '', '', '', '', Math.round(t.sumRub * 100) / 100])
  if (t.withoutPrice) lines.push(['', '', `Без цены: ${t.withoutPrice} поз. — в итог не входят`])
  return '﻿' + lines.map(l => l.map(cell).join(';')).join('\r\n') + '\r\n'
}

/** Текст для вставки в мессенджер или заявку поставщику. */
export function toText(rows: OrderRow[], title: string): string {
  const out = [title, '']
  let last: string | null = null
  for (const r of rows) {
    if (r.supplier !== last) { out.push(r.supplier ? `— ${r.supplier}` : '— без поставщика'); last = r.supplier }
    out.push(`${r.comp.name}${r.comp.sku ? ` (${r.comp.sku})` : ''}: ${r.order} ${r.comp.unit}`)
  }
  return out.join('\n')
}

// ── документ заказа поставщику ──────────────────────────────────────────────

export interface PoLine { name: string; unit: string; qty: number; price: number; currency: Currency; sku?: string | null }

/** Заказ поставщику: позиции, цены в валюте заказа и итог по каждой валюте. */
export function purchaseOrderCsv(title: string, lines: PoLine[]): string {
  const rows: (string | number)[][] = [[title], [], ['№', 'Артикул', 'Наименование', 'Кол-во', 'Ед.', 'Цена', 'Валюта', 'Сумма']]
  lines.forEach((l, i) => rows.push([i + 1, l.sku ?? '', l.name, l.qty, l.unit, l.price > 0 ? l.price : '', l.price > 0 ? l.currency : '', l.price > 0 ? round3(l.qty * l.price) : '']))
  const byCur = new Map<string, number>()
  for (const l of lines) if (l.price > 0) byCur.set(l.currency, (byCur.get(l.currency) ?? 0) + l.qty * l.price)
  rows.push([])
  for (const [cur, sum] of byCur) rows.push(['', '', 'ИТОГО', '', '', '', cur, Math.round(sum * 100) / 100])
  return '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n') + '\r\n'
}

export function purchaseOrderText(title: string, lines: PoLine[]): string {
  return [title, '', ...lines.map((l, i) => `${i + 1}. ${l.name}${l.sku ? ` (${l.sku})` : ''} — ${l.qty} ${l.unit}`)].join('\n')
}

/** Сумма заказа в рублях по текущему курсу; null — есть позиции без цены или курса. */
export function purchaseOrderRub(lines: PoLine[], rates: Rate[]) {
  let sum = 0
  let unknown = 0
  for (const l of lines) {
    const k = l.price > 0 ? toRub(l.price, l.currency, rates) : null
    if (k === null) unknown++
    else sum += k * l.qty
  }
  return { sum, unknown }
}

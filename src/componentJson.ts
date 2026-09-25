// Загрузка компонентов из JSON (обычно его составляет ИИ по прайсу или заявке).
// Модуль чистый: без React и сети, проверяется node-тестами.

import type { Currency } from './money.ts'

export const FORMAT_ID = 'first-logic-components'
export const MAX_COMPONENTS = 500

export interface Known {
  categories: { id: string; name: string }[]
  suppliers: { id: string; name: string }[]
  components: { id: string; name: string; sku: string | null }[]
}

export interface ImportRow {
  index: number
  name: string
  sku: string | null
  manufacturer: string | null
  unit: string
  price: number
  /** цена указана в файле; иначе в базу пойдёт 0, а строка будет помечена «нет цены» */
  priceGiven: boolean
  currency: Currency
  stock: number | null
  minStock: number | null
  location: string | null
  url: string | null
  notes: string
  categoryId: string | null
  categoryName: string | null
  supplierId: string | null
  supplierName: string | null
  /** поставщика с таким названием ещё нет — будет создан */
  newSupplier: boolean
  /** db — такой компонент уже есть; file — повтор внутри файла */
  duplicate: 'db' | 'file' | null
  existingId: string | null
  errors: string[]
  warnings: string[]
}

export interface ParseResult { rows: ImportRow[]; fatal?: string }

const KEYS: Record<string, string[]> = {
  name: ['name', 'название', 'наименование'],
  sku: ['sku', 'артикул'],
  manufacturer: ['manufacturer', 'производитель'],
  category: ['category', 'категория'],
  supplier: ['supplier', 'поставщик'],
  unit: ['unit', 'единица', 'ед'],
  price: ['price', 'цена'],
  currency: ['currency', 'валюта'],
  stock: ['stock', 'остаток'],
  min_stock: ['min_stock', 'минимальный_остаток', 'мин_остаток'],
  location: ['location', 'место', 'место_хранения'],
  url: ['url', 'ссылка'],
  notes: ['notes', 'примечание', 'заметки', 'комментарий'],
}

const CURRENCY_ALIASES: Record<string, Currency> = {
  rub: 'RUB', руб: 'RUB', рубль: 'RUB', рублей: 'RUB', '₽': 'RUB', р: 'RUB',
  usd: 'USD', '$': 'USD', доллар: 'USD', долларов: 'USD',
  cny: 'CNY', rmb: 'CNY', '¥': 'CNY', юань: 'CNY', юаней: 'CNY', yuan: 'CNY',
  eur: 'EUR', '€': 'EUR', евро: 'EUR',
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '_')
const lc = (s: string | null) => (s ?? '').trim().toLowerCase()

function field(obj: Record<string, unknown>, name: string): unknown {
  const wanted = KEYS[name]
  for (const k of Object.keys(obj)) if (wanted.includes(norm(k))) return obj[k]
  return undefined
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** «188,00», «1 200,5», 188 → число; пусто → null; мусор → NaN. */
export function parseNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN
  const s = String(v).replace(/[\s ]/g, '').replace(',', '.')
  if (s === '') return null
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN
}

/** ИИ часто оборачивает ответ в ```json … ``` — снимаем ограду. */
function stripFence(raw: string) {
  const t = raw.trim()
  const m = t.match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i)
  return m ? m[1] : t
}

export function parseComponentFile(raw: string, known: Known): ParseResult {
  let data: unknown
  try { data = JSON.parse(stripFence(raw)) } catch (e) {
    return { rows: [], fatal: `Это не JSON: ${(e as Error).message}. Попросите ИИ вернуть «только JSON, без пояснений».` }
  }
  const list = Array.isArray(data) ? data : (data as { components?: unknown })?.components
  if (!Array.isArray(list)) return { rows: [], fatal: 'В файле нет списка «components». Скопируйте формат из подсказки для ИИ.' }
  if (list.length === 0) return { rows: [], fatal: 'Список компонентов пуст.' }
  if (list.length > MAX_COMPONENTS) return { rows: [], fatal: `Слишком много строк: ${list.length}. За раз — не больше ${MAX_COMPONENTS}.` }

  const catByName = new Map(known.categories.map(c => [lc(c.name), c]))
  const supByName = new Map(known.suppliers.map(s => [lc(s.name), s]))
  const bySku = new Map(known.components.filter(c => c.sku).map(c => [lc(c.sku), c.id]))
  const byName = new Map(known.components.map(c => [lc(c.name), c.id]))
  const seen = new Set<string>()

  const rows = list.map((item, i): ImportRow => {
    const errors: string[] = []
    const warnings: string[] = []
    const o = (item && typeof item === 'object' && !Array.isArray(item) ? item : {}) as Record<string, unknown>
    if (item === null || typeof item !== 'object' || Array.isArray(item)) errors.push('строка должна быть объектом { "name": … }')

    const name = text(field(o, 'name')) ?? ''
    if (!name) errors.push('нет названия (name)')
    if (name.length > 200) errors.push('название длиннее 200 символов')

    let price = 0
    let priceGiven = false
    const p = parseNumber(field(o, 'price'))
    if (p !== null) {
      if (Number.isNaN(p) || p < 0) errors.push(`цена «${String(field(o, 'price'))}» — не число`)
      else { price = p; priceGiven = p > 0 }
    }

    let currency: Currency = 'RUB'
    const cRaw = text(field(o, 'currency'))
    if (cRaw) {
      const c = CURRENCY_ALIASES[cRaw.toLowerCase()] ?? CURRENCY_ALIASES[cRaw.toUpperCase().toLowerCase()]
      if (c) currency = c
      else errors.push(`валюта «${cRaw}» не подходит. Допустимо: RUB, USD, CNY, EUR`)
    } else if (priceGiven) warnings.push('валюта не указана — взяты рубли')

    const num = (key: string, label: string) => {
      const v = parseNumber(field(o, key))
      if (v === null) return null
      if (Number.isNaN(v) || v < 0) { errors.push(`${label} «${String(field(o, key))}» — не число`); return null }
      return v
    }
    const stock = num('stock', 'остаток')
    const minStock = num('min_stock', 'минимальный остаток')

    const catName = text(field(o, 'category'))
    const cat = catName ? catByName.get(lc(catName)) : undefined
    if (catName && !cat) warnings.push(`категория «${catName}» не найдена — останется пустой (создайте её в «Категориях»)`)

    const supName = text(field(o, 'supplier'))
    const sup = supName ? supByName.get(lc(supName)) : undefined

    const sku = text(field(o, 'sku'))
    const url = text(field(o, 'url'))
    if (url && !/^https?:\/\//i.test(url)) warnings.push('ссылка не начинается с http — не сохранится')

    let duplicate: ImportRow['duplicate'] = null
    let existingId: string | null = null
    const key = sku ? `sku:${lc(sku)}` : `name:${lc(name)}`
    if (name && seen.has(key)) duplicate = 'file'
    else if (name) {
      seen.add(key)
      existingId = (sku ? bySku.get(lc(sku)) : undefined) ?? byName.get(lc(name)) ?? null
      if (existingId) duplicate = 'db'
    }
    if (!priceGiven && !errors.length) warnings.push('цена не указана — заполните позже')

    return {
      index: i + 1, name, sku, manufacturer: text(field(o, 'manufacturer')), unit: text(field(o, 'unit')) ?? 'шт',
      price, priceGiven, currency, stock, minStock, location: text(field(o, 'location')),
      url: url && /^https?:\/\//i.test(url) ? url : null, notes: text(field(o, 'notes')) ?? '',
      categoryId: cat?.id ?? null, categoryName: cat?.name ?? null,
      supplierId: sup?.id ?? null, supplierName: sup?.name ?? supName, newSupplier: !!supName && !sup,
      duplicate, existingId, errors, warnings,
    }
  })
  return { rows }
}

// ── шаблон и подсказка для ИИ ───────────────────────────────────────────────

export function buildTemplate() {
  return {
    format: FORMAT_ID,
    version: 1,
    components: [
      { name: 'Кабель GX16 (мама-папа) 50 метров', category: 'Кабели', price: 188, currency: 'CNY', notes: 'Срок: two days' },
      { name: 'Разъём GX16M-8A', sku: 'GX16M-8A', category: 'Разъёмы', price: 2, currency: 'CNY' },
      { name: 'Герметичный переходник 9pin(мама) на 8pin(папа)', category: 'Разъёмы' },
    ],
  }
}

/** Текст для любого ИИ-ассистента. Категории подставляются из справочника. */
export function aiPrompt(categories: string[]) {
  const cats = categories.length ? categories.map(c => `"${c}"`).join(', ') : '(категорий пока нет — ставь null)'
  return `Преврати прикреплённый прайс, заявку или список деталей в JSON для загрузки в справочник компонентов First Logic.

Верни только JSON, без пояснений и без markdown-обёртки, в таком виде:
{
  "format": "first-logic-components",
  "version": 1,
  "components": [
    {
      "name": "Наименование (обязательно, до 200 символов)",
      "sku": "артикул или null",
      "manufacturer": "производитель или null",
      "category": "одно из значений: ${cats}; если ни одно не подходит — null",
      "supplier": "продавец или магазин, только если он явно указан; иначе null",
      "unit": "единица измерения, по умолчанию \\"шт\\"",
      "price": "цена ЗА ОДНУ ЕДИНИЦУ, число с точкой (188.50), без пробелов и знаков валюты; если цены нет — null",
      "currency": "RUB | USD | CNY | EUR — по заголовку колонки с ценой (например «Цена, CNY»)",
      "stock": "null. Заполняй только если в документе явно написан остаток на складе",
      "min_stock": null,
      "location": null,
      "url": "ссылка на товар или null",
      "notes": "срок поставки и прочие пометки, например \\"Срок: in stock\\""
    }
  ]
}

Правила:
- Колонка «Кол-во» в прайсе или заявке — это сколько покупать, а НЕ остаток на складе. Не клади её в stock.
- Колонки «№», «Сумма», строки «ИТОГО» и пустые строки не переноси.
- Цену не выдумывай и не вычисляй: нет цены — null. Цена всегда за одну единицу, не сумма строки.
- Название бери как в документе, только убери лишние пробелы. Длина или количество в названии («50 метров») остаются в названии.
- Максимум ${MAX_COMPONENTS} позиций за один раз.`
}

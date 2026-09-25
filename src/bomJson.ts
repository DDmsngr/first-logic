// Загрузка состава (BOM) из JSON, который составляет ИИ по спецификации или схеме.
// Сопоставление со справочником — здесь, а не у ИИ: он не знает наших записей.

export const FORMAT_ID = 'first-logic-bom'
export const MAX_ROWS = 300

export interface KnownItem { id: string; name: string; sku: string | null }

export interface BomImportRow {
  index: number
  name: string
  sku: string | null
  qty: number
  unit: string | null
  note: string
  /** найдено в справочнике */
  match: { kind: 'component' | 'assembly'; id: string; name: string; by: 'sku' | 'name' } | null
  /** уже стоит в составе этого изделия/узла */
  inBom: boolean
  /** сколько строк файла слилось в эту (одна деталь несколько раз) */
  merged: number
  errors: string[]
}

export interface BomParseResult { rows: BomImportRow[]; fatal?: string }

/** «Резистор 10k 0805» и «резистор  10K, 0805» — одно и то же. */
export const normName = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[\s,.;:()«»"'_-]+/g, ' ').trim()

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.replace(/[\s ]/g, '').replace(',', '.')
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN
}
const text = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null)

function stripFence(raw: string) {
  const t = raw.trim()
  const m = t.match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i)
  return m ? m[1] : t
}

export function parseBomFile(raw: string, known: { components: KnownItem[]; assemblies: KnownItem[] }, inBom: Set<string>): BomParseResult {
  let data: unknown
  try { data = JSON.parse(stripFence(raw)) } catch (e) {
    return { rows: [], fatal: `Это не JSON: ${(e as Error).message}. Попросите ИИ вернуть «только JSON, без пояснений».` }
  }
  const list = Array.isArray(data) ? data : (data as { items?: unknown })?.items
  if (!Array.isArray(list)) return { rows: [], fatal: 'В файле нет списка «items». Скопируйте формат из подсказки для ИИ.' }
  if (!list.length) return { rows: [], fatal: 'Список пуст.' }
  if (list.length > MAX_ROWS) return { rows: [], fatal: `Слишком много строк: ${list.length}. За раз — не больше ${MAX_ROWS}.` }

  const bySku = new Map<string, KnownItem & { kind: 'component' | 'assembly' }>()
  const byName = new Map<string, KnownItem & { kind: 'component' | 'assembly' }>()
  for (const [kind, items] of [['assembly', known.assemblies], ['component', known.components]] as const) {
    for (const it of items) {
      if (it.sku) bySku.set(it.sku.trim().toLowerCase(), { ...it, kind })
      byName.set(normName(it.name), { ...it, kind })
    }
  }

  const rows: BomImportRow[] = []
  const bySlot = new Map<string, BomImportRow>()
  list.forEach((item, i) => {
    const o = (item && typeof item === 'object' && !Array.isArray(item) ? item : {}) as Record<string, unknown>
    const errors: string[] = []
    const name = text(o.name ?? o['наименование'] ?? o['название']) ?? ''
    const sku = text(o.sku ?? o['артикул'])
    const q = num(o.qty ?? o['количество'] ?? o['кол-во'])
    if (!name && !sku) errors.push('нет названия и артикула')
    if (q === null) errors.push('нет количества')
    else if (Number.isNaN(q) || q <= 0) errors.push(`количество «${String(o.qty)}» — не положительное число`)

    const hit = (sku && bySku.get(sku.toLowerCase())) || (name && byName.get(normName(name))) || null
    const match = hit ? { kind: hit.kind, id: hit.id, name: hit.name, by: (sku && bySku.get(sku.toLowerCase()) ? 'sku' : 'name') as 'sku' | 'name' } : null
    // одна и та же деталь несколькими строками (C1, C2 …) — суммируем
    const slot = match ? `${match.kind}:${match.id}` : `new:${sku?.toLowerCase() ?? normName(name)}`
    const prev = !errors.length ? bySlot.get(slot) : undefined
    if (prev) {
      prev.qty += q!
      prev.merged++
      const n = text(o.note)
      if (n) prev.note = prev.note ? `${prev.note}, ${n}` : n
      return
    }
    const row: BomImportRow = {
      index: i + 1, name: name || sku!, sku, qty: q && !Number.isNaN(q) ? q : 0, unit: text(o.unit), note: text(o.note) ?? '',
      match, inBom: !!match && inBom.has(match.id), merged: 1, errors,
    }
    rows.push(row)
    if (!errors.length) bySlot.set(slot, row)
  })
  return { rows }
}

export const AI_PROMPT = `Преврати прикреплённую спецификацию, перечень элементов или схему в JSON для загрузки состава изделия в First Logic.

Верни только JSON, без пояснений и без markdown-обёртки, в таком виде:
{
  "format": "first-logic-bom",
  "version": 1,
  "items": [
    { "name": "Наименование как в документе", "sku": "артикул / партномер или null", "qty": 2, "unit": "шт", "note": "позиционные обозначения, например C1, C5 — или пусто" }
  ]
}

Правила:
- qty — количество на ОДНО изделие, число.
- Если одна и та же деталь встречается несколько раз (разные позиционные обозначения) — можно одной строкой с суммарным qty, обозначения перечисли в note.
- Партномер производителя (BLF188XR, GRM188R71H104KA93) клади в sku — по нему деталь найдётся в справочнике точнее, чем по названию.
- Не выдумывай позиции и количества. Строки «Итого», заголовки и пустые строки не переноси.
- Максимум ${MAX_ROWS} строк.`

// Себестоимость по составу (BOM). Чистые функции: одни и те же для страниц,
// финансов и Telegram-бота. Все суммы — в рублях по текущему курсу.

import { toRub, type Currency, type Rate } from './money.ts'

export interface CostComponent { id: string; name: string; price: number; currency: Currency; unit: string; stock: number }
export interface CostAssembly { id: string; name: string; cost_override: number | null }
export interface BomItem {
  id: string
  parent_product_id: string | null
  parent_assembly_id: string | null
  component_id: string | null
  child_assembly_id: string | null
  qty: number
  price_override: number | null
  price_currency: Currency
  note: string
  position: number
}

export interface CostData {
  components: CostComponent[]
  assemblies: CostAssembly[]
  items: BomItem[]
  rates: Rate[]
}

export type Warning =
  | { kind: 'no_rate'; currency: Currency; name: string }
  | { kind: 'no_price'; name: string }
  | { kind: 'missing'; name: string }
  | { kind: 'cycle'; name: string }

export interface Line {
  item: BomItem
  name: string
  type: 'component' | 'assembly'
  /** цена единицы в рублях; null — посчитать нельзя (нет курса) */
  unitRub: number | null
  /** откуда цена: из карточки компонента, ручная в строке, расчёт узла, ручная у узла */
  source: 'component' | 'line' | 'calculated' | 'override'
  totalRub: number | null
}

export interface Cost {
  /** итог: ручная цена узла, если задана, иначе расчёт */
  total: number
  /** расчёт по составу (без ручной цены узла) */
  calculated: number
  override: number | null
  lines: Line[]
  warnings: Warning[]
}

const byParent = (items: BomItem[], key: 'parent_product_id' | 'parent_assembly_id', id: string) =>
  items.filter(i => i[key] === id).sort((a, b) => a.position - b.position)

/**
 * Считалка с памятью: каждый узел считается один раз, даже если он входит во
 * многие изделия. Цикл (защищён и в БД) не вешает расчёт, а даёт предупреждение.
 */
export function createCosting(d: CostData) {
  const comp = new Map(d.components.map(c => [c.id, c]))
  const asm = new Map(d.assemblies.map(a => [a.id, a]))
  const memo = new Map<string, Cost>()
  const inProgress = new Set<string>()

  function lines(items: BomItem[]): { lines: Line[]; sum: number; warnings: Warning[] } {
    const out: Line[] = []
    const warnings: Warning[] = []
    let sum = 0
    for (const it of items) {
      let line: Line
      if (it.component_id) {
        const c = comp.get(it.component_id)
        if (!c) { warnings.push({ kind: 'missing', name: 'удалённый компонент' }); continue }
        const own = it.price_override !== null
        const cur = own ? it.price_currency : c.currency
        const unitRub = toRub(own ? it.price_override! : c.price, cur, d.rates)
        if (unitRub === null) warnings.push({ kind: 'no_rate', currency: cur, name: c.name })
        else if (unitRub === 0) warnings.push({ kind: 'no_price', name: c.name })
        line = { item: it, name: c.name, type: 'component', unitRub, source: own ? 'line' : 'component', totalRub: unitRub === null ? null : unitRub * it.qty }
      } else {
        const a = asm.get(it.child_assembly_id!)
        if (!a) { warnings.push({ kind: 'missing', name: 'удалённый узел' }); continue }
        if (it.price_override !== null) {
          const unitRub = toRub(it.price_override, it.price_currency, d.rates)
          if (unitRub === null) warnings.push({ kind: 'no_rate', currency: it.price_currency, name: a.name })
          line = { item: it, name: a.name, type: 'assembly', unitRub, source: 'line', totalRub: unitRub === null ? null : unitRub * it.qty }
        } else {
          const sub = assembly(a.id)
          warnings.push(...sub.warnings)
          line = { item: it, name: a.name, type: 'assembly', unitRub: sub.total, source: sub.override !== null ? 'override' : 'calculated', totalRub: sub.total * it.qty }
        }
      }
      if (line.totalRub !== null) sum += line.totalRub
      out.push(line)
    }
    return { lines: out, sum, warnings }
  }

  function assembly(id: string): Cost {
    const hit = memo.get(id)
    if (hit) return hit
    const a = asm.get(id)
    if (!a) return { total: 0, calculated: 0, override: null, lines: [], warnings: [{ kind: 'missing', name: 'удалённый узел' }] }
    if (inProgress.has(id)) return { total: 0, calculated: 0, override: null, lines: [], warnings: [{ kind: 'cycle', name: a.name }] }
    inProgress.add(id)
    const r = lines(byParent(d.items, 'parent_assembly_id', id))
    inProgress.delete(id)
    const cost: Cost = { total: a.cost_override ?? r.sum, calculated: r.sum, override: a.cost_override, lines: r.lines, warnings: r.warnings }
    memo.set(id, cost)
    return cost
  }

  function product(id: string): Cost {
    const r = lines(byParent(d.items, 'parent_product_id', id))
    return { total: r.sum, calculated: r.sum, override: null, lines: r.lines, warnings: r.warnings }
  }

  /**
   * Сколько каждого компонента уйдёт на count штук: узлы раскрываются до
   * компонентов. Узел с ручной ценой всё равно раскрывается — ручная цена
   * влияет на деньги, а не на то, что нужно со склада.
   */
  function explode(parent: { productId?: string; assemblyId?: string }, count = 1): Map<string, number> {
    const need = new Map<string, number>()
    const walk = (items: BomItem[], mult: number, path: Set<string>) => {
      for (const it of items) {
        const q = it.qty * mult
        if (it.component_id) need.set(it.component_id, (need.get(it.component_id) ?? 0) + q)
        else if (it.child_assembly_id && !path.has(it.child_assembly_id)) {
          walk(byParent(d.items, 'parent_assembly_id', it.child_assembly_id), q, new Set([...path, it.child_assembly_id]))
        }
      }
    }
    if (parent.productId) walk(byParent(d.items, 'parent_product_id', parent.productId), count, new Set())
    if (parent.assemblyId) walk(byParent(d.items, 'parent_assembly_id', parent.assemblyId), count, new Set([parent.assemblyId]))
    return need
  }

  /** Где используется компонент или узел: прямые родители с количеством. */
  function usedIn(target: { componentId?: string; assemblyId?: string }) {
    return d.items.filter(i => (target.componentId && i.component_id === target.componentId)
      || (target.assemblyId && i.child_assembly_id === target.assemblyId))
  }

  /** Узлы, которые нельзя добавить в узел id: он сам и все, кто его содержит. */
  function ancestors(assemblyId: string): Set<string> {
    const out = new Set<string>([assemblyId])
    let grew = true
    while (grew) {
      grew = false
      for (const i of d.items) {
        if (i.child_assembly_id && out.has(i.child_assembly_id) && i.parent_assembly_id && !out.has(i.parent_assembly_id)) {
          out.add(i.parent_assembly_id); grew = true
        }
      }
    }
    return out
  }

  return { assembly, product, explode, usedIn, ancestors }
}

export function describeWarning(w: Warning) {
  switch (w.kind) {
    case 'no_rate': return `нет курса ${w.currency} — «${w.name}» не посчитан`
    case 'no_price': return `у «${w.name}» не задана цена`
    case 'missing': return `в составе ${w.name}`
    case 'cycle': return `узел «${w.name}» входит сам в себя`
  }
}

/** Одинаковые предупреждения из разных веток схлопываются. */
export function uniqueWarnings(ws: Warning[]) {
  const seen = new Set<string>()
  return ws.filter(w => { const k = describeWarning(w); if (seen.has(k)) return false; seen.add(k); return true })
}

// ── полная себестоимость и маржа ────────────────────────────────────────────

export interface CostParams {
  manufacturing_cost: number
  additional_cost: number
  overhead_pct: number
  cost_override: number | null
}

export interface UnitEconomics {
  material: number
  manufacturing: number
  additional: number
  overhead: number
  /** расчёт по формуле */
  calculated: number
  override: number | null
  /** что идёт в прибыль: ручная, если задана, иначе расчёт */
  total: number
  price: number | null
  profit: number | null
  /** доля прибыли в цене, % */
  margin: number | null
  /** наценка к себестоимости, % */
  markup: number | null
}

/**
 * Себестоимость = материалы + производство + прочее + накладные% × (материалы + производство).
 * Прибыль = цена − себестоимость; маржа = прибыль / цена; наценка = прибыль / себестоимость.
 */
export function unitEconomics(material: number, p: CostParams, priceRub: number | null): UnitEconomics {
  const overhead = (p.overhead_pct / 100) * (material + p.manufacturing_cost)
  const calculated = material + p.manufacturing_cost + p.additional_cost + overhead
  const total = p.cost_override ?? calculated
  const profit = priceRub === null ? null : priceRub - total
  return {
    material, manufacturing: p.manufacturing_cost, additional: p.additional_cost, overhead,
    calculated, override: p.cost_override, total, price: priceRub, profit,
    margin: profit === null || !priceRub ? null : (profit / priceRub) * 100,
    markup: profit === null || !total ? null : (profit / total) * 100,
  }
}

// Агрегаты расходов для раздела «Финансы». Чистые функции, суммы в рублях.

export interface ExpenseLike {
  spent_on: string
  amount_rub: number
  category_id: string | null
  product_id: string | null
  supplier_id: string | null
}

export type Period = 'month' | 'quarter' | 'year' | 'all' | 'custom'

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Границы периода [from, to] включительно; для 'all' — null. */
export function periodRange(p: Period, today = new Date(), custom?: { from: string; to: string }): { from: string; to: string } | null {
  const y = today.getFullYear(), m = today.getMonth()
  switch (p) {
    case 'month': return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) }
    case 'quarter': { const q = Math.floor(m / 3) * 3; return { from: iso(new Date(y, q, 1)), to: iso(new Date(y, q + 3, 0)) } }
    case 'year': return { from: `${y}-01-01`, to: `${y}-12-31` }
    case 'custom': return custom && custom.from && custom.to ? custom : null
    default: return null
  }
}

export const inRange = (d: string, r: { from: string; to: string } | null) => !r || (d >= r.from && d <= r.to)

export function sumBy<T extends ExpenseLike>(list: T[], key: (e: T) => string | null) {
  const m = new Map<string | null, number>()
  for (const e of list) m.set(key(e), (m.get(key(e)) ?? 0) + e.amount_rub)
  return [...m.entries()].map(([id, sum]) => ({ id, sum })).sort((a, b) => b.sum - a.sum)
}

/** Суммы по месяцам подряд, без пропусков: пустой месяц — ноль, а не дыра. */
export function byMonth(list: ExpenseLike[], range: { from: string; to: string } | null) {
  if (!list.length && !range) return []
  const months = list.map(e => e.spent_on.slice(0, 7)).sort()
  const first = range ? range.from.slice(0, 7) : months[0]
  const last = range ? range.to.slice(0, 7) : months[months.length - 1]
  const out: { month: string; sum: number }[] = []
  let [y, m] = first.split('-').map(Number)
  const [ly, lm] = last.split('-').map(Number)
  while (y < ly || (y === ly && m <= lm)) {
    const key = `${y}-${pad(m)}`
    out.push({ month: key, sum: list.filter(e => e.spent_on.startsWith(key)).reduce((s, e) => s + e.amount_rub, 0) })
    m++; if (m > 12) { m = 1; y++ }
    if (out.length > 120) break
  }
  return out
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
export const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number)
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`
}

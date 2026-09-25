// Качество: итог испытания и сравнение ревизий состава. Чистые функции.
import type { Line } from './costing.ts'

export interface TestParam { name: string; unit?: string; min: number | null; max: number | null }
export interface Measurement extends TestParam { value: number | null }
export type TestResult = 'pass' | 'fail' | 'pending'

/** Значение вне допуска? null — значения ещё нет. */
export function outOfRange(m: Measurement): boolean | null {
  if (m.value === null || !Number.isFinite(m.value)) return null
  return (m.min !== null && m.value < m.min) || (m.max !== null && m.value > m.max)
}

/** То же правило, что fl_test_result в базе: брак важнее незаконченного. */
export function testResult(ms: Measurement[]): TestResult {
  if (ms.some(m => outOfRange(m) === true)) return 'fail'
  if (ms.length === 0 || ms.some(m => outOfRange(m) === null)) return 'pending'
  return 'pass'
}

export const RESULT_META: Record<TestResult, { label: string; color: string }> = {
  pass: { label: 'Годен', color: '#5fd08f' },
  fail: { label: 'Брак', color: '#f06a6a' },
  pending: { label: 'Не закончено', color: '#f2b94b' },
}

// ── ревизии ─────────────────────────────────────────────────────────────────

export interface RevLine { kind: 'component' | 'assembly'; ref_id: string; name: string; qty: number; unit: string; unit_rub: number | null; total_rub: number | null }

/** Снимок текущего состава для записи ревизии. */
export function snapshot(lines: Line[], unitOf: (componentId: string) => string): RevLine[] {
  return lines.map(l => ({
    kind: l.type, ref_id: (l.item.component_id ?? l.item.child_assembly_id)!, name: l.name, qty: l.item.qty,
    unit: l.type === 'component' ? unitOf(l.item.component_id!) : 'шт', unit_rub: l.unitRub, total_rub: l.totalRub,
  }))
}

export interface RevDiff {
  added: RevLine[]
  removed: RevLine[]
  changed: { was: RevLine; now: RevLine; qty: boolean; price: boolean }[]
  totalWas: number
  totalNow: number
}

const round2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100)

/** Что изменилось от ревизии (was) к текущему составу (now). Цена считается изменившейся от 1 копейки. */
export function diffRevision(was: RevLine[], now: RevLine[]): RevDiff {
  const key = (l: RevLine) => `${l.kind}:${l.ref_id}`
  const w = new Map(was.map(l => [key(l), l]))
  const n = new Map(now.map(l => [key(l), l]))
  const changed: RevDiff['changed'] = []
  for (const [k, a] of w) {
    const b = n.get(k)
    if (!b) continue
    const qty = a.qty !== b.qty
    const price = round2(a.unit_rub) !== round2(b.unit_rub)
    if (qty || price) changed.push({ was: a, now: b, qty, price })
  }
  const sum = (ls: RevLine[]) => ls.reduce((s, l) => s + (l.total_rub ?? 0), 0)
  return {
    added: now.filter(l => !w.has(key(l))),
    removed: was.filter(l => !n.has(key(l))),
    changed,
    totalWas: sum(was),
    totalNow: sum(now),
  }
}

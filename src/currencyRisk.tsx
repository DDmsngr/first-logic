import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchActivity } from './api'
import { useWorkspace } from './auth'
import type { Product } from './catalog'
import { useCosting, useRates } from './catalogParts'
import { createCosting, currencyShare, scaleRate, unitEconomics } from './costing'
import { fmtDate } from './meta'
import { CURRENCIES, fmtMoney, type Currency } from './money'

const STEPS = [-20, -10, 10, 20, 30]
const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`

/** Какая часть материалов в какой валюте и что будет с маржой, если курс сдвинется. */
export function CurrencyRisk({ product: p, priceRub }: { product: Product; priceRub: number | null }) {
  const c = useCosting()
  const rates = useRates()
  const [cur, setCur] = useState<Currency | null>(null)
  const [step, setStep] = useState(10)
  if (!c.k || !rates.data) return null

  const data = { components: c.components, assemblies: c.assemblies, items: c.items, rates: rates.data }
  const share = currencyShare(data, { productId: p.id })
  const total = [...share.values()].reduce((a, b) => a + b, 0)
  const foreign = [...share.keys()].filter(k => k !== 'RUB') as Currency[]
  if (!total || foreign.length === 0) return (
    <p className="dash-muted mt-3 border-t border-[var(--d-line)] pt-2 text-xs">Все материалы в рублях — от курса себестоимость не зависит.</p>
  )

  const active = cur && foreign.includes(cur) ? cur : foreign.sort((a, b) => (share.get(b) ?? 0) - (share.get(a) ?? 0))[0]
  const base = unitEconomics(c.k.product(p.id).total, p, priceRub)
  const shifted = createCosting({ ...data, rates: scaleRate(rates.data, active, step) }).product(p.id).total
  const next = unitEconomics(shifted, p, priceRub)
  const sign = (CURRENCIES.find(x => x.id === active)?.sign) ?? active

  return (
    <div className="mt-4 border-t border-[var(--d-line)] pt-3" aria-label="Риск курса">
      <h3 className="dash-label mb-2">Материалы по валютам и риск курса</h3>
      <div className="flex h-2 gap-[2px] overflow-hidden rounded-[4px]" role="img"
        aria-label={[...share].map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`).join(', ')}>
        {[...share].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
          <div key={k} style={{ width: `${(v / total) * 100}%`, background: k === 'RUB' ? 'var(--d-line-strong)' : k === active ? 'var(--d-accent)' : '#6ea8fe' }} title={`${k}: ${fmtMoney(v, 'RUB')}`} />
        ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {[...share].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
          <li key={k}><span className="dash-muted">{k}</span> <span className="tabular-nums">{Math.round((v / total) * 100)}%</span> <span className="dash-muted tabular-nums">· {fmtMoney(v, 'RUB')}</span></li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span>Если</span>
        <select className="dash-input !min-h-8 !w-auto" value={active} onChange={e => setCur(e.target.value as Currency)} aria-label="Валюта">
          {foreign.map(k => <option key={k} value={k}>{k} ({CURRENCIES.find(x => x.id === k)?.label})</option>)}
        </select>
        <span>изменится на</span>
        <div className="flex gap-1" role="group" aria-label="Насколько">
          {STEPS.map(s => (
            <button key={s} type="button" onClick={() => setStep(s)} aria-pressed={s === step}
              className={`dash-btn dash-btn-sm !min-h-8 !px-2 ${s === step ? '' : 'dash-btn-ghost'}`}>{pct(s)}</button>
          ))}
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <div><dt className="dash-muted text-xs">Себестоимость</dt><dd className="tabular-nums">{fmtMoney(next.total, 'RUB')} <span className="dash-muted text-xs">{fmtMoney(next.total - base.total, 'RUB')}</span></dd></div>
        <div><dt className="dash-muted text-xs">Прибыль</dt><dd className="tabular-nums">{fmtMoney(next.profit, 'RUB')}</dd></div>
        <div><dt className="dash-muted text-xs">Маржа</dt>
          <dd className="tabular-nums">{next.margin === null ? '—' : `${next.margin.toFixed(1)}%`}
            {base.margin !== null && next.margin !== null && <span className={`ml-1 text-xs ${next.margin < base.margin ? 'text-[var(--d-warn)]' : 'text-[var(--d-ok)]'}`}>было {base.margin.toFixed(1)}%</span>}
          </dd></div>
      </dl>
      {p.cost_override !== null && <p className="dash-muted mt-1 text-xs">Задана ручная себестоимость — она от курса не меняется; расчёт выше показывает, куда ушла бы формула.</p>}
      <p className="dash-muted mt-1 text-xs">{sign} сейчас: {(rates.data.find(r => r.currency === active)?.manual_rate ?? rates.data.find(r => r.currency === active)?.cbr_rate)?.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) ?? '—'} ₽</p>
    </div>
  )
}

/** Как менялась цена компонента: из журнала изменений. */
export function PriceHistory({ componentId }: { componentId: string }) {
  const { workspace } = useWorkspace()
  const q = useQuery({ queryKey: ['activity', workspace.id, componentId, 'price'], queryFn: () => fetchActivity(workspace.id, 0, { entityId: componentId }) })
  const points = (q.data ?? []).filter(e => e.action === 'component.price').map(e => {
    const [v, c] = (e.meta.to ?? '').split(' ')
    return { at: e.created_at, value: Number(v), currency: c, reason: e.meta.reason }
  }).filter(p => Number.isFinite(p.value)).reverse()
  if (points.length === 0) return <p className="dash-muted text-sm">Цена не менялась с момента создания.</p>
  const sameCur = points.every(p => p.currency === points[0].currency)
  const vals = points.map(p => p.value)
  const min = Math.min(...vals), max = Math.max(...vals)
  const W = 280, H = 48
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${(i / Math.max(points.length - 1, 1)) * W},${max === min ? H / 2 : H - ((p.value - min) / (max - min)) * (H - 6) - 3}`).join(' ')
  const first = vals[0], last = vals[vals.length - 1]
  return (
    <div>
      {sameCur && points.length > 1 && (
        <div className="mb-2 flex items-center gap-3">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-12 w-72 max-w-full" role="img" aria-label={`Цена: ${points.map(p => p.value).join(' → ')} ${points[0].currency}`}>
            <path d={path} fill="none" stroke="var(--d-accent)" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          <span className={`text-sm tabular-nums ${last > first ? 'text-[var(--d-warn)]' : 'text-[var(--d-ok)]'}`}>{pct(((last - first) / first) * 100)}</span>
        </div>
      )}
      <ul className="text-sm">
        {[...points].reverse().slice(0, 8).map((p, i) => (
          <li key={i} className="dash-row flex gap-3 py-1.5">
            <span className="dash-muted w-20 shrink-0">{fmtDate(p.at)}</span>
            <span className="tabular-nums">{p.value.toLocaleString('ru-RU', { maximumFractionDigits: 4 })} {p.currency}</span>
            {p.reason && <span className="dash-muted truncate text-xs">{p.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

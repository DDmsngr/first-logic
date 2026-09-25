import { CurrencyRisk } from './currencyRisk'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import { updateProduct, type Product, type ProductCostPatch } from './catalog'
import type { UnitEconomics } from './costing'
import { PriceStructure, useExpenses } from './financeParts'
import { fmtMoney, parseAmount } from './money'
import { Field, Modal, errMsg, useToast } from './ui'

const pct = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`)

function Row({ label, value, hint, strong, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; strong?: boolean; tone?: 'ok' | 'bad' | 'warn' }) {
  const color = tone === 'ok' ? 'text-[var(--d-ok)]' : tone === 'bad' ? 'text-[var(--d-danger)]' : tone === 'warn' ? 'text-[var(--d-warn)]' : ''
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1 ${strong ? 'font-semibold' : ''}`}>
      <dt className={strong ? '' : 'dash-muted'}>{label}{hint && <span className="dash-muted block text-[11px] font-normal">{hint}</span>}</dt>
      <dd className={`shrink-0 text-right tabular-nums ${color}`}>{value}</dd>
    </div>
  )
}

/**
 * Полная себестоимость и маржа изделия. Каждая строка — с формулой и числами,
 * чтобы было видно, откуда взялся итог.
 */
export function EconomicsCard({ product: p, u, hasBom }: { product: Product; u: UnitEconomics; hasBom: boolean }) {
  const [edit, setEdit] = useState(false)
  const expenses = useExpenses({ productId: p.id })
  const spent = (expenses.data ?? []).reduce((s, e) => s + e.amount_rub, 0)
  const diff = u.override !== null ? u.override - u.calculated : null

  return (
    <section className="dash-card p-4" aria-label="Себестоимость и маржа">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="dash-label">Себестоимость и маржа · за 1 шт</h2>
        <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setEdit(true)}><SlidersHorizontal className="h-3.5 w-3.5" aria-hidden /> Параметры</button>
      </div>

      <div className="grid gap-x-8 md:grid-cols-2">
        <dl className="text-sm">
          <Row label="Материалы (BOM)" value={fmtMoney(u.material, 'RUB')} hint={hasBom ? 'по составу, текущие цены и курсы' : 'состав не заполнен'} />
          <Row label="Производство" value={fmtMoney(u.manufacturing, 'RUB')} hint="сборка, монтаж, настройка — за штуку" />
          <Row label="Прочее" value={fmtMoney(u.additional, 'RUB')} hint="упаковка, доставка, сертификация — за штуку" />
          <Row label={`Накладные ${pct(p.overhead_pct)}`} value={fmtMoney(u.overhead, 'RUB')}
            hint={`${pct(p.overhead_pct)} × (${fmtMoney(u.material, 'RUB')} + ${fmtMoney(u.manufacturing, 'RUB')})`} />
          <div className="my-1 border-t border-[var(--d-line)]" />
          <Row label="Себестоимость (расчёт)" value={fmtMoney(u.calculated, 'RUB')} strong={u.override === null} />
          {u.override !== null && (
            <>
              <Row label="Себестоимость (ручная)" value={fmtMoney(u.override, 'RUB')} strong />
              <Row label="Разница с расчётом" value={`${diff! > 0 ? '+' : ''}${fmtMoney(diff, 'RUB')}`} tone="warn" />
            </>
          )}
        </dl>

        <dl className="mt-3 text-sm md:mt-0">
          <Row label="Цена продажи" value={u.price === null ? 'не задана' : fmtMoney(u.price, 'RUB')} hint={p.actual_price !== null ? 'фактическая' : p.planned_price !== null ? 'плановая' : undefined} />
          <Row label="Прибыль" value={fmtMoney(u.profit, 'RUB')} hint="цена − себестоимость" strong tone={u.profit === null ? undefined : u.profit >= 0 ? 'ok' : 'bad'} />
          <Row label="Маржа" value={pct(u.margin)} hint="прибыль / цена" tone={u.margin === null ? undefined : u.margin >= 0 ? 'ok' : 'bad'} />
          <Row label="Наценка" value={pct(u.markup)} hint="прибыль / себестоимость" />
          {p.planned_qty > 0 && u.price !== null && (
            <>
              <div className="my-1 border-t border-[var(--d-line)]" />
              <Row label={`План продаж: ${p.planned_qty} шт`} value={fmtMoney(u.price * p.planned_qty, 'RUB')} hint="плановая выручка" />
              <Row label="Плановая прибыль" value={fmtMoney((u.profit ?? 0) * p.planned_qty, 'RUB')} tone={(u.profit ?? 0) >= 0 ? 'ok' : 'bad'} />
            </>
          )}
        </dl>
      </div>

      {u.price !== null && <div className="mt-4"><PriceStructure u={u} /></div>}
      {hasBom && <CurrencyRisk product={p} priceRub={u.price} />}

      <p className="dash-muted mt-3 border-t border-[var(--d-line)] pt-2 text-xs">
        Расходы, привязанные к изделию: <Link className="underline" to={`/finance?product=${p.id}`}>{fmtMoney(spent, 'RUB')}</Link>
        {expenses.data && ` (${expenses.data.length} записей)`}
        {p.planned_qty > 0 && spent > 0 && <> — на план {p.planned_qty} шт это {fmtMoney(spent / p.planned_qty, 'RUB')} за штуку</>}
      </p>

      <CostParamsModal open={edit} onClose={() => setEdit(false)} product={p} calculated={u.calculated} />
    </section>
  )
}

function CostParamsModal({ open, onClose, product: p, calculated }: { open: boolean; onClose: () => void; product: Product; calculated: number }) {
  return (
    <Modal open={open} onClose={onClose} title="Параметры себестоимости">
      {open && <CostParamsForm product={p} calculated={calculated} onClose={onClose} />}
    </Modal>
  )
}

function CostParamsForm({ product: p, calculated, onClose }: { product: Product; calculated: number; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const s = (n: number | null) => (n === null || n === 0 ? '' : String(n))
  const [f, setF] = useState({
    manufacturing: s(p.manufacturing_cost), additional: s(p.additional_cost), overhead: s(p.overhead_pct),
    override: p.cost_override === null ? '' : String(p.cost_override), qty: s(p.planned_qty),
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  const save = useMutation({
    mutationFn: (patch: ProductCostPatch) => updateProduct(p.id, patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['product', p.id] }); qc.invalidateQueries({ queryKey: ['products'] }); toast('Параметры сохранены'); onClose() },
    onError: e => toast(errMsg(e), 'error'),
  })
  const num = (v: string) => (v.trim() ? parseAmount(v) : 0)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const patch: ProductCostPatch = {
      manufacturing_cost: num(f.manufacturing), additional_cost: num(f.additional), overhead_pct: num(f.overhead),
      cost_override: f.override.trim() ? parseAmount(f.override) : null, planned_qty: Math.round(num(f.qty)),
    }
    const vals = [patch.manufacturing_cost, patch.additional_cost, patch.overhead_pct, patch.planned_qty, patch.cost_override ?? 0]
    if (vals.some(v => !Number.isFinite(v!) || v! < 0)) { toast('Все значения — неотрицательные числа', 'error'); return }
    save.mutate(patch)
  }
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Производство, ₽ за шт" hint="Сборка, монтаж, настройка"><input className="dash-input" inputMode="decimal" autoFocus value={f.manufacturing} onChange={set('manufacturing')} placeholder="0" /></Field>
      <Field label="Прочее, ₽ за шт" hint="Упаковка, доставка, сертификация"><input className="dash-input" inputMode="decimal" value={f.additional} onChange={set('additional')} placeholder="0" /></Field>
      <Field label="Накладные, %" hint="От материалов + производства"><input className="dash-input" inputMode="decimal" value={f.overhead} onChange={set('overhead')} placeholder="0" /></Field>
      <Field label="План продаж, шт" hint="Для плановой выручки и прибыли"><input className="dash-input" inputMode="numeric" value={f.qty} onChange={set('qty')} placeholder="0" /></Field>
      <div className="sm:col-span-2">
        <Field label="Ручная себестоимость, ₽" hint={`Если задана — идёт в прибыль вместо расчёта (сейчас расчёт ${fmtMoney(calculated, 'RUB')}). Пусто — по формуле.`}>
          <input className="dash-input" inputMode="decimal" value={f.override} onChange={set('override')} placeholder="по формуле" />
        </Field>
      </div>
      <p className="dash-muted rounded-md bg-black/25 p-3 text-xs sm:col-span-2">
        Себестоимость = материалы (BOM) + производство + прочее + накладные% × (материалы + производство).<br />
        Прибыль = цена − себестоимость. Маржа = прибыль ÷ цена. Наценка = прибыль ÷ себестоимость.
      </p>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
        <button className="dash-btn" disabled={save.isPending}>Сохранить</button>
      </div>
    </form>
  )
}

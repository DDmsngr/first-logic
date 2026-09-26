import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Lock, Plus, Trash2 } from 'lucide-react'
import { useWorkspace } from '../auth'
import { useCosting, useProducts, useRates } from '../catalogParts'
import { unitEconomics } from '../costing'
import { fmtDate, fmtDateTime, todayIso } from '../meta'
import { fmtMoney, fmtQty, parseAmount, toRub } from '../money'
import { NEXT_STATUS, PAYMENT_LABEL, SALE_STATUSES, paymentState, saleMargin, saleTotal } from '../saleMath'
import { addSaleItem, deleteSale, deleteSaleItem, fetchSale, fetchSaleUnits, updateSale, updateSaleItem, type Sale, type SaleItem } from '../sales'
import { reserve } from '../stock'
import { ActivityList } from '../shared'
import { DateInput, Field, PageHeader, QueryState, errMsg, useToast } from '../ui'
import { UnitChip } from '../units'
import { SaleStatusChip } from './Sales'

export default function SaleDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const { byUser } = useWorkspace()
  const products = useProducts()
  const rates = useRates()
  const cost = useCosting()
  const q = useQuery({ queryKey: ['sale', id], queryFn: () => fetchSale(id) })
  const units = useQuery({ queryKey: ['sale-units', id], queryFn: () => fetchSaleUnits(id) })
  const o = q.data
  const [reserved, setReserved] = useState(false)

  const refresh = () => ['sale', 'sales', 'sale-units', 'activity'].forEach(k => qc.invalidateQueries({ queryKey: [k] }))
  const patch = useMutation({
    mutationFn: (p: Parameters<typeof updateSale>[1]) => updateSale(id, p),
    onSuccess: refresh, onError: e => { toast(errMsg(e), 'error'); refresh() },
  })
  const del = useMutation({
    mutationFn: () => deleteSale(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sales'] }); nav('/sales') },
    onError: e => toast(errMsg(e), 'error'),
  })
  const doReserve = useMutation({
    mutationFn: async () => {
      for (const it of o!.items) if (it.product_id) await reserve({ productId: it.product_id }, it.qty, `Заказ клиента №${o!.num}`)
    },
    onSuccess: () => { setReserved(true); toast('Детали зарезервированы под заказ'); ['reserved', 'reservations', 'component-reservations', 'activity'].forEach(k => qc.invalidateQueries({ queryKey: [k] })) },
    onError: e => toast(errMsg(e), 'error'),
  })

  const total = o ? saleTotal(o.items) : 0
  const pay = o ? paymentState(total, o.paid) : null

  // себестоимость штуки в рублях по каждой позиции — по составу изделия
  const margin = useMemo(() => {
    if (!o || !cost.k || !products.data || !rates.data) return null
    const lines = o.items.map(it => {
      const p = products.data.find(x => x.id === it.product_id)
      const unitCost = p ? unitEconomics(cost.k!.product(p.id).total, p, null).total : null
      return { qty: it.qty, unitCostRub: unitCost && unitCost > 0 ? unitCost : null, revenueRub: toRub(it.qty * it.price, o.currency, rates.data) ?? 0 }
    })
    return saleMargin(toRub(total, o.currency, rates.data) ?? 0, lines)
  }, [o, cost.k, products.data, rates.data, total])

  if (!o || !pay) return <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty emptyText="Заказ не найден"><></></QueryState>
  const editable = o.status === 'new'
  const next = NEXT_STATUS[o.status]
  const open = ['new', 'in_progress', 'ready'].includes(o.status)
  const shippedBy = (pid: string | null) => (units.data ?? []).filter(u => u.product_id === pid && u.status === 'shipped').length

  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/sales" className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> Продажи</Link>
      <PageHeader title={`Заказ №${o.num} · ${o.customer}`}
        sub={<span className="flex flex-wrap items-center gap-2"><SaleStatusChip status={o.status} /><span>создан {fmtDateTime(o.created_at)}, {byUser(o.created_by)?.name ?? '—'}</span></span>}
        actions={<>
          {next && <button className="dash-btn" disabled={patch.isPending} onClick={() => patch.mutate({ status: next })}>{SALE_STATUSES.find(s => s.id === next)!.label} <ArrowRight className="h-4 w-4" aria-hidden /></button>}
          {open && <button className="dash-btn dash-btn-ghost" onClick={() => confirm('Отменить заказ?') && patch.mutate({ status: 'cancelled' })}>Отменить</button>}
          {o.status === 'cancelled' && <button className="dash-btn dash-btn-ghost" onClick={() => patch.mutate({ status: 'new' })}>Вернуть в новые</button>}
          {(o.status === 'new' || o.status === 'cancelled') && <button className="dash-btn dash-btn-ghost" aria-label="Удалить заказ" onClick={() => confirm('Удалить заказ безвозвратно?') && del.mutate()}><Trash2 className="h-4 w-4" aria-hidden /></button>}
        </>} />

      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <section className="dash-card space-y-3 p-4" aria-label="Заказ">
          <Field label="Контакт"><EditText value={o.contact} placeholder="Телефон, telegram, email" onSave={v => patch.mutate({ contact: v })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Срок"><DateInput value={o.due_on ?? ''} min={todayIso()} onChange={v => patch.mutate({ due_on: v || null })} /></Field>
            <Field label="Валюта"><input className="dash-input" readOnly value={o.currency} /></Field>
          </div>
          <Field label="Примечание"><EditText value={o.note} multiline onSave={v => patch.mutate({ note: v })} /></Field>
        </section>

        <section className="dash-card p-4" aria-label="Оплата">
          <h2 className="dash-label mb-2">Оплата</h2>
          <div className="text-2xl font-semibold tabular-nums">{fmtMoney(total, o.currency)}</div>
          <div className={`mb-3 text-sm ${pay.state === 'unpaid' ? 'text-[var(--d-warn)]' : pay.state === 'paid' ? 'text-[var(--d-ok)]' : 'dash-muted'}`}>
            {PAYMENT_LABEL[pay.state]}{pay.due > 0 ? `, ещё ${fmtMoney(pay.due, o.currency)}` : ''}
          </div>
          <Field label={`Оплачено, ${o.currency}`}>
            <EditNumber value={o.paid} onSave={v => patch.mutate({ paid: v })} />
          </Field>
          <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm mt-2" disabled={pay.due <= 0 || patch.isPending} onClick={() => patch.mutate({ paid: total })}>Оплачен полностью</button>
        </section>
      </div>

      <section className="dash-card mb-4 p-4" aria-label="Позиции">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="dash-label mr-auto">Позиции</h2>
          {open && <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={doReserve.isPending || reserved} onClick={() => confirm('Зарезервировать детали под все позиции заказа? Склад не изменится.') && doReserve.mutate()}
            title="Компоненты по составу помечаются как обещанные под этот заказ"><Lock className="h-4 w-4" aria-hidden /> {reserved ? 'Зарезервировано' : 'Зарезервировать детали'}</button>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="dash-label text-left"><th className="py-1.5 pr-2 font-normal">Изделие</th><th className="px-2 text-right font-normal">Кол-во</th><th className="px-2 text-right font-normal">Цена</th><th className="px-2 text-right font-normal">Сумма</th><th className="px-2 text-right font-normal">Отгружено</th><th /></tr></thead>
            <tbody>
              {o.items.map(it => (
                <ItemRow key={it.id} it={it} sale={o} editable={editable} shipped={shippedBy(it.product_id)} onChanged={refresh} />
              ))}
            </tbody>
          </table>
        </div>
        {editable && <AddItem sale={o} onDone={refresh} />}
        <div className="mt-2 text-right text-sm">Итого: <b className="tabular-nums">{fmtMoney(total, o.currency)}</b></div>
      </section>

      {margin && open && (
        <section className="dash-card mb-4 p-4" aria-label="Маржа">
          <h2 className="dash-label mb-2">Прикидка маржи по расчётной себестоимости</h2>
          {margin.cost === 0
            ? <p className="dash-muted text-sm">У изделий заказа нет состава — себестоимость неизвестна.</p>
            : (
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div><div className="dash-muted text-xs">Выручка</div><div className="tabular-nums">{fmtMoney(margin.revenueRub, 'RUB')}</div></div>
                <div><div className="dash-muted text-xs">Себестоимость</div><div className="tabular-nums">{fmtMoney(margin.cost, 'RUB')}</div></div>
                <div><div className="dash-muted text-xs">Прибыль</div><div className={`tabular-nums ${margin.profit < 0 ? 'text-[var(--d-danger)]' : 'text-[var(--d-ok)]'}`}>{fmtMoney(margin.profit, 'RUB')}{margin.margin !== null && ` · ${margin.margin.toFixed(1)}%`}</div></div>
              </div>
            )}
          {margin.missing > 0 && <p className="dash-muted mt-2 text-xs">Позиций без себестоимости: {margin.missing} — они в расчёт не вошли.</p>}
        </section>
      )}

      {(units.data?.length ?? 0) > 0 && (
        <section className="dash-card mb-4 p-4" aria-label="Отгруженные экземпляры">
          <h2 className="dash-label mb-2">Отгруженные экземпляры · {units.data!.length}</h2>
          <ul className="flex flex-wrap gap-2 text-sm">
            {units.data!.map(u => <li key={u.id}><Link to={`/units/${u.id}`} className="dash-chip dash-mono hover:underline">{u.serial}</Link> <UnitChip status={u.status as 'shipped'} /> <span className="dash-muted text-xs">{fmtDate(u.shipped_on)}</span></li>)}
          </ul>
        </section>
      )}

      <section className="dash-card p-4" aria-label="История"><h2 className="dash-label mb-3">История</h2><ActivityList entityId={o.id} empty="Событий пока нет" /></section>
    </div>
  )
}

function EditText({ value, onSave, placeholder, multiline }: { value: string; onSave: (v: string) => void; placeholder?: string; multiline?: boolean }) {
  const [v, setV] = useState(value)
  const commit = () => { if (v.trim() !== value) onSave(v.trim()) }
  return multiline
    ? <textarea className="dash-input" rows={2} value={v} onChange={e => setV(e.target.value)} onBlur={commit} maxLength={2000} placeholder={placeholder} />
    : <input className="dash-input" value={v} onChange={e => setV(e.target.value)} onBlur={commit} maxLength={300} placeholder={placeholder} />
}

function EditNumber({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value).replace('.', ','))
  const commit = () => { const n = parseAmount(v); if (Number.isFinite(n) && n >= 0 && n !== value) onSave(n); else setV(String(value).replace('.', ',')) }
  return <input className="dash-input text-right" inputMode="decimal" value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
}

function ItemRow({ it, sale, editable, shipped, onChanged }: { it: SaleItem; sale: Sale; editable: boolean; shipped: number; onChanged: () => void }) {
  const toast = useToast()
  const upd = useMutation({
    mutationFn: (p: { qty?: number; price?: number }) => updateSaleItem(it.id, p),
    onSuccess: onChanged, onError: e => { toast(errMsg(e), 'error'); onChanged() },
  })
  const del = useMutation({ mutationFn: () => deleteSaleItem(it.id), onSuccess: onChanged, onError: e => toast(errMsg(e), 'error') })
  return (
    <tr className="dash-row align-middle">
      <td className="py-2 pr-2">{it.product_id ? <Link to={`/products/${it.product_id}`} className="hover:underline">{it.name}</Link> : it.name}</td>
      <td className="px-2 text-right tabular-nums">{editable ? <NumCell value={it.qty} onSave={v => v > 0 && upd.mutate({ qty: v })} label="Количество" /> : fmtQty(it.qty)}</td>
      <td className="px-2 text-right tabular-nums">{editable ? <NumCell value={it.price} onSave={v => upd.mutate({ price: v })} label="Цена" /> : fmtMoney(it.price, sale.currency)}</td>
      <td className="px-2 text-right tabular-nums">{fmtMoney(it.qty * it.price, sale.currency)}</td>
      <td className="px-2 text-right tabular-nums"><span className={shipped >= it.qty ? 'text-[var(--d-ok)]' : 'dash-muted'}>{shipped} из {fmtQty(it.qty)}</span></td>
      <td className="pl-2 text-right">{editable && <button className="dash-btn dash-btn-ghost dash-btn-sm !px-2" aria-label={`Убрать ${it.name}`} disabled={sale.items.length === 1} onClick={() => del.mutate()}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>}</td>
    </tr>
  )
}

function NumCell({ value, onSave, label }: { value: number; onSave: (v: number) => void; label: string }) {
  const [v, setV] = useState(String(value).replace('.', ','))
  const commit = () => { const n = parseAmount(v); if (Number.isFinite(n) && n >= 0 && n !== value) onSave(n); else setV(String(value).replace('.', ',')) }
  return <input className="dash-input !min-h-8 !w-24 text-right" inputMode="decimal" aria-label={label} value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
}

function AddItem({ sale, onDone }: { sale: Sale; onDone: () => void }) {
  const products = useProducts()
  const toast = useToast()
  const [product, setProduct] = useState('')
  const add = useMutation({
    mutationFn: () => {
      const p = products.data?.find(x => x.id === product)
      if (!p) throw new Error('Выберите изделие')
      const price = p.price_currency === sale.currency ? (p.actual_price ?? p.planned_price ?? 0) : 0
      return addSaleItem(sale.id, p.id, `${p.name}${p.version ? ` ${p.version}` : ''}`, 1, price, sale.items.length)
    },
    onSuccess: () => { setProduct(''); onDone() },
    onError: e => toast(errMsg(e), 'error'),
  })
  return (
    <div className="mt-2 flex gap-2">
      <select className="dash-input" value={product} onChange={e => setProduct(e.target.value)} aria-label="Добавить изделие">
        <option value="">Добавить изделие…</option>
        {products.data?.map(p => <option key={p.id} value={p.id}>{p.name}{p.version ? ` ${p.version}` : ''}</option>)}
      </select>
      <button className="dash-btn dash-btn-ghost" disabled={!product || add.isPending} onClick={() => add.mutate()}><Plus className="h-4 w-4" aria-hidden /> Добавить</button>
    </div>
  )
}

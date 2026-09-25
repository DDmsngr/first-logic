import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, Copy, FileDown, PackageCheck, Send, Trash2, Undo2, X } from 'lucide-react'
import { useSuppliers, useRates } from '../catalogParts'
import { saveText } from '../download'
import { fmtDate, fmtDateTime } from '../meta'
import { CURRENCIES, fmtMoney, fmtQty, parseAmount, type Currency } from '../money'
import { purchaseOrderCsv, purchaseOrderRub, purchaseOrderText } from '../orders'
import { ActivityList } from '../shared'
import {
  deleteOrder, deleteOrderItem, fetchOrder, receiveOrder, setOrderStatus, updateOrder, updateOrderItem,
  type OrderItem, type PurchaseOrder,
} from '../stock'
import { DateInput, Field, Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'
import { OrderStatusChip } from './Orders'

const REFRESH = ['orders', 'order', 'components', 'component', 'expenses', 'activity']

export default function OrderDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [receiving, setReceiving] = useState(false)
  const q = useQuery({ queryKey: ['order', id], queryFn: () => fetchOrder(id) })
  const sups = useSuppliers()
  const rates = useRates()

  const refresh = () => REFRESH.forEach(k => qc.invalidateQueries({ queryKey: [k] }))
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: e => toast(errMsg(e), 'error'),
  })

  const o = q.data
  if (!o) return <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty emptyText="Заказ не найден"><></></QueryState>

  const sup = sups.data?.find(s => s.id === o.supplier_id)
  const title = `Заказ №${o.num}${sup ? ` — ${sup.name}` : ''}`
  const draft = o.status === 'draft'
  const total = purchaseOrderRub(o.items, rates.data ?? [])
  const byCur = new Map<Currency, number>()
  for (const i of o.items) if (i.price > 0) byCur.set(i.currency, (byCur.get(i.currency) ?? 0) + i.qty * i.price)
  const lines = o.items.map(i => ({ name: i.name, unit: i.unit, qty: i.qty, price: i.price, currency: i.currency }))

  const copy = async () => {
    try { await navigator.clipboard.writeText(purchaseOrderText(title, lines)); toast('Заказ скопирован') }
    catch { toast('Не удалось скопировать', 'error') }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/orders" className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> Заказы</Link>
      <PageHeader title={`Заказ №${o.num}`}
        sub={<span className="flex flex-wrap items-center gap-2"><OrderStatusChip status={o.status} />
          <span className="text-xs">создан {fmtDateTime(o.created_at)}{o.ordered_at && ` · отправлен ${fmtDate(o.ordered_at)}`}{o.received_at && ` · принят ${fmtDate(o.received_at)}`}</span></span>}
        actions={<>
          <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => void copy()}><Copy className="h-4 w-4" aria-hidden /> Текст</button>
          <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => saveText(`Заказ ${o.num}${sup ? ' ' + sup.name.replace(/[\\/:*?"<>|]+/g, ' ') : ''}.csv`, purchaseOrderCsv(title, lines))}>
            <FileDown className="h-4 w-4" aria-hidden /> CSV</button>
        </>} />

      <section className="dash-card mb-4 grid gap-3 p-4 sm:grid-cols-3" aria-label="Параметры заказа">
        <Field label="Поставщик">
          <select className="dash-input" value={o.supplier_id ?? ''} disabled={o.status === 'received'}
            onChange={e => run.mutate(() => updateOrder(o.id, { supplier_id: e.target.value || null }))}>
            <option value="">Не указан</option>
            {sups.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Ожидаем к">
          <DateInput value={o.expected_on ?? ''} disabled={o.status === 'received'} onChange={v => run.mutate(() => updateOrder(o.id, { expected_on: v || null }))} />
        </Field>
        <Field label="Комментарий">
          <input className="dash-input" defaultValue={o.note} placeholder="Номер счёта, трек, условия"
            onBlur={e => e.target.value !== o.note && run.mutate(() => updateOrder(o.id, { note: e.target.value }))} />
        </Field>
      </section>

      <section className="dash-card mb-4 p-4" aria-label="Действия">
        <div className="flex flex-wrap items-center gap-2">
          {draft && <button className="dash-btn" disabled={run.isPending || o.items.length === 0} onClick={() => run.mutate(() => setOrderStatus(o.id, 'ordered'), { onSuccess: () => toast('Отмечен как отправленный — компоненты «Заказан»') })}>
            <Send className="h-4 w-4" aria-hidden /> Отправлен поставщику</button>}
          {o.status === 'ordered' && <button className="dash-btn" onClick={() => setReceiving(true)}><PackageCheck className="h-4 w-4" aria-hidden /> Принять…</button>}
          {(o.status === 'ordered' || o.status === 'cancelled') && <button className="dash-btn dash-btn-ghost" disabled={run.isPending} onClick={() => run.mutate(() => setOrderStatus(o.id, 'draft'))}>
            <Undo2 className="h-4 w-4" aria-hidden /> В черновик</button>}
          {(draft || o.status === 'ordered') && <button className="dash-btn dash-btn-ghost" disabled={run.isPending}
            onClick={() => confirm(`Отменить заказ №${o.num}?`) && run.mutate(() => setOrderStatus(o.id, 'cancelled'))}><X className="h-4 w-4" aria-hidden /> Отменить заказ</button>}
          {(draft || o.status === 'cancelled') && <button className="dash-btn dash-btn-ghost !text-[var(--d-danger)]" disabled={run.isPending}
            onClick={() => confirm(`Удалить заказ №${o.num}?`) && run.mutate(() => deleteOrder(o.id), { onSuccess: () => nav('/orders') })}><Trash2 className="h-4 w-4" aria-hidden /> Удалить</button>}
          {o.status === 'received' && o.expense_id && <Link to="/finance?period=all" className="dash-btn dash-btn-ghost"><Check className="h-4 w-4" aria-hidden /> Расход записан в Финансы</Link>}
        </div>
        <p className="dash-muted mt-2 text-xs">
          {draft && 'Черновик: позиции и цены можно менять. Когда отправите поставщику — нажмите «Отправлен».'}
          {o.status === 'ordered' && 'Ждём поставку. Когда придёт — «Принять»: отметите, что реально пришло, и склад пополнится.'}
          {o.status === 'received' && 'Принят: остатки пополнены. Изменить принятый заказ нельзя.'}
          {o.status === 'cancelled' && 'Отменён: на склад не повлиял.'}
        </p>
      </section>

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Позиции">
        <h2 className="dash-label mb-2">Позиции · {o.items.length}</h2>
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="dash-label border-b border-[var(--d-line)] text-left">
                <th className="py-2 pl-4 pr-2 font-medium">Позиция</th>
                <th className="px-2 py-2 text-right font-medium">Кол-во</th>
                <th className="px-2 py-2 text-right font-medium">Цена</th>
                <th className="px-2 py-2 text-right font-medium">Сумма</th>
                {o.status === 'received' && <th className="px-2 py-2 text-right font-medium">Пришло</th>}
                {draft && <th className="w-12" />}
              </tr>
            </thead>
            <tbody>{o.items.map(i => <ItemRow key={i.id} i={i} draft={draft} received={o.status === 'received'} onChange={run.mutate} />)}</tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
          {[...byCur].map(([c, s]) => <span key={c} className="tabular-nums">{fmtMoney(s, c)}</span>)}
          <b className="tabular-nums">≈ {fmtMoney(total.sum, 'RUB')}</b>
          {total.unknown > 0 && <span className="text-[var(--d-warn)]">без цены: {total.unknown}</span>}
        </div>
      </section>

      <section className="dash-card p-4" aria-label="История"><h2 className="dash-label mb-3">История</h2><ActivityList entityId={o.id} empty="Событий пока нет" /></section>

      {receiving && <ReceiveModal order={o} onClose={() => setReceiving(false)} onDone={refresh} />}
    </div>
  )
}

function ItemRow({ i, draft, received, onChange }: {
  i: OrderItem; draft: boolean; received: boolean; onChange: (fn: () => Promise<unknown>) => void
}) {
  const [qty, setQty] = useState(String(i.qty))
  const [price, setPrice] = useState(i.price ? String(i.price) : '')
  const commit = () => {
    const q = parseAmount(qty), p = price.trim() ? parseAmount(price) : 0
    if (!(q > 0) || !Number.isFinite(p) || p < 0) { setQty(String(i.qty)); setPrice(i.price ? String(i.price) : ''); return }
    if (q !== i.qty || p !== i.price) onChange(() => updateOrderItem(i.id, { qty: q, price: p }))
  }
  return (
    <tr className="dash-row align-middle">
      <td className="py-2 pl-4 pr-2">{i.component_id ? <Link to={`/components/${i.component_id}`} className="font-medium hover:underline">{i.name}</Link> : <span className="font-medium">{i.name}</span>}</td>
      <td className="px-2 py-2 text-right">
        {draft ? <input className="dash-input !min-h-8 !w-20 text-right" inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} onBlur={commit} aria-label={`Количество «${i.name}»`} />
          : <span className="tabular-nums">{fmtQty(i.qty)}</span>} <span className="dash-muted text-xs">{i.unit}</span>
      </td>
      <td className="px-2 py-2 text-right">
        {draft ? (
          <span className="inline-flex items-center gap-1">
            <input className="dash-input !min-h-8 !w-24 text-right" inputMode="decimal" placeholder="нет" value={price} onChange={e => setPrice(e.target.value)} onBlur={commit} aria-label={`Цена «${i.name}»`} />
            <select className="dash-input !min-h-8 !w-20" value={i.currency} aria-label="Валюта" onChange={e => onChange(() => updateOrderItem(i.id, { currency: e.target.value as Currency }))}>
              {CURRENCIES.map(c => <option key={c.id} value={c.id}>{c.id}</option>)}
            </select>
          </span>
        ) : <span className="tabular-nums">{i.price > 0 ? fmtMoney(i.price, i.currency) : '—'}</span>}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{i.price > 0 ? fmtMoney(i.price * i.qty, i.currency) : '—'}</td>
      {received && <td className={`px-2 py-2 text-right tabular-nums ${i.received_qty !== null && i.received_qty < i.qty ? 'text-[var(--d-warn)]' : ''}`}>{fmtQty(i.received_qty ?? 0)}</td>}
      {draft && <td className="pr-4 text-right"><button className="dash-btn dash-btn-ghost dash-btn-sm !px-2" aria-label={`Убрать «${i.name}»`}
        onClick={() => confirm(`Убрать «${i.name}» из заказа?`) && onChange(() => deleteOrderItem(i.id))}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button></td>}
    </tr>
  )
}

function ReceiveModal({ order: o, onClose, onDone }: { order: PurchaseOrder; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [got, setGot] = useState<Record<string, string>>(() => Object.fromEntries(o.items.map(i => [i.id, String(i.qty)])))
  const [updatePrices, setUpdatePrices] = useState(true)
  const [expense, setExpense] = useState(true)
  const run = useMutation({
    mutationFn: () => {
      const lines = o.items.map(i => ({ item_id: i.id, qty: parseAmount(got[i.id] ?? '0') }))
      if (lines.some(l => !Number.isFinite(l.qty) || l.qty < 0)) throw new Error('Количество — неотрицательные числа')
      if (lines.every(l => l.qty === 0)) throw new Error('Ничего не пришло? Тогда лучше отменить заказ')
      return receiveOrder(o.id, lines, updatePrices, expense)
    },
    onSuccess: exp => { toast(exp ? 'Принято: склад пополнен, расход записан' : 'Принято: склад пополнен'); onDone(); onClose() },
    onError: e => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open onClose={onClose} title={`Приёмка заказа №${o.num}`}>
      <div className="space-y-3">
        <p className="dash-muted text-sm">Укажите, сколько реально пришло. Недостача останется видна в заказе.</p>
        <ul className="max-h-72 overflow-y-auto rounded-md border border-[var(--d-line)] text-sm">
          {o.items.map(i => (
            <li key={i.id} className="dash-row flex items-center gap-2 px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate">{i.name}</span>
              <span className="dash-muted text-xs tabular-nums">заказано {fmtQty(i.qty)}</span>
              <input className="dash-input !min-h-8 !w-20 text-right" inputMode="decimal" value={got[i.id]} aria-label={`Пришло «${i.name}»`}
                onChange={e => setGot(g => ({ ...g, [i.id]: e.target.value }))} />
              <span className="dash-muted w-8 text-xs">{i.unit}</span>
            </li>
          ))}
        </ul>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 accent-[var(--d-accent)]" checked={updatePrices} onChange={e => setUpdatePrices(e.target.checked)} />
          <span>Обновить цены компонентов ценами из заказа<span className="dash-muted block text-xs">Себестоимость изделий пересчитается по новым ценам</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 accent-[var(--d-accent)]" checked={expense} onChange={e => setExpense(e.target.checked)} />
          <span>Записать расход в Финансы<span className="dash-muted block text-xs">Сумма принятого по ценам заказа, категория «Компоненты»</span></span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
          <button className="dash-btn" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Принимаем…' : 'Принять'}</button>
        </div>
      </div>
    </Modal>
  )
}

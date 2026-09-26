import { useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useWorkspace } from '../auth'
import { useProducts, useRates } from '../catalogParts'
import { fmtDate, todayIso } from '../meta'
import { CURRENCIES, fmtMoney, parseAmount, toRub, type Currency } from '../money'
import { PAYMENT_LABEL, SALE_STATUSES, paymentState, saleTotal, type SaleStatus } from '../saleMath'
import { createSale, fetchSales } from '../sales'
import { DateInput, Field, Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'

export function SaleStatusChip({ status }: { status: SaleStatus }) {
  const s = SALE_STATUSES.find(x => x.id === status)!
  return <span className="dash-chip" style={{ color: s.color, borderColor: `${s.color}66` }}>{s.label}</span>
}

export default function Sales() {
  const { workspace } = useWorkspace()
  const rates = useRates()
  const [status, setStatus] = useState<string>('open')
  const [creating, setCreating] = useState(false)
  const list = useQuery({ queryKey: ['sales', workspace.id], queryFn: () => fetchSales(workspace.id) })
  const all = list.data ?? []
  const items = all.filter(o => (status === 'open' ? ['new', 'in_progress', 'ready'].includes(o.status) : status === 'all' || o.status === status))
  const count = (s: string) => all.filter(o => (s === 'open' ? ['new', 'in_progress', 'ready'].includes(o.status) : s === 'all' || o.status === s)).length
  const today = todayIso()

  // сводка по открытым заказам в рублях
  const summary = useMemo(() => {
    const open = all.filter(o => ['new', 'in_progress', 'ready'].includes(o.status))
    let total = 0, due = 0
    for (const o of open) {
      const t = saleTotal(o.items), p = paymentState(t, o.paid)
      total += toRub(t, o.currency, rates.data ?? []) ?? 0
      due += toRub(p.due, o.currency, rates.data ?? []) ?? 0
    }
    return { n: open.length, total, due }
  }, [all, rates.data])

  const TABS = [{ id: 'open', label: 'Открытые' }, ...SALE_STATUSES.map(s => ({ id: s.id, label: s.label })), { id: 'all', label: 'Все' }]

  return (
    <>
      <PageHeader title="Продажи" sub="Заказы клиентов: что заказали, на какую сумму, оплачено ли и что отгружено."
        actions={<button className="dash-btn" onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Новый заказ</button>} />

      {summary.n > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <div className="dash-card p-3"><div className="dash-label">Открытых</div><div className="text-xl font-semibold tabular-nums">{summary.n}</div></div>
          <div className="dash-card p-3"><div className="dash-label">На сумму</div><div className="text-xl font-semibold tabular-nums">{fmtMoney(summary.total, 'RUB')}</div></div>
          <div className="dash-card p-3"><div className="dash-label">Ждём оплаты</div><div className="text-xl font-semibold tabular-nums">{fmtMoney(summary.due, 'RUB')}</div></div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Статус">
        {TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={status === t.id} onClick={() => setStatus(t.id)} className={`dash-btn dash-btn-sm ${status === t.id ? '' : 'dash-btn-ghost'}`}>
            {t.label}{count(t.id) ? <span className="tabular-nums opacity-70"> {count(t.id)}</span> : null}
          </button>
        ))}
      </div>

      <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} empty={items.length === 0}
        emptyText={all.length ? 'В этой вкладке заказов нет' : 'Заказов клиентов пока нет'} emptyHint="Создайте заказ: изделия, количество, цена — дальше можно резервировать детали и отгружать по номерам">
        <ul className="dash-card divide-y divide-[var(--d-line)]">
          {items.map(o => {
            const t = saleTotal(o.items)
            const pay = paymentState(t, o.paid)
            const late = o.due_on && o.due_on < today && ['new', 'in_progress', 'ready'].includes(o.status)
            return (
              <li key={o.id}>
                <Link to={`/sales/${o.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-white/5">
                  <span className="dash-mono">№{o.num}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{o.customer}</span>
                  <SaleStatusChip status={o.status} />
                  <span className="tabular-nums">{fmtMoney(t, o.currency)}</span>
                  <span className={`w-full text-xs sm:w-auto ${pay.state === 'unpaid' ? 'text-[var(--d-warn)]' : 'dash-muted'}`}>{PAYMENT_LABEL[pay.state]}{pay.due > 0 ? `, ещё ${fmtMoney(pay.due, o.currency)}` : ''}</span>
                  {o.due_on && <span className={`text-xs ${late ? 'text-[var(--d-danger)]' : 'dash-muted'}`}>{late ? 'просрочен · ' : 'до '}{fmtDate(o.due_on)}</span>}
                </Link>
              </li>
            )
          })}
        </ul>
      </QueryState>

      <Modal open={creating} onClose={() => setCreating(false)} title="Новый заказ клиента">
        {creating && <NewSaleForm onDone={() => setCreating(false)} />}
      </Modal>
    </>
  )
}

interface Row { product: string; qty: string; price: string }

function NewSaleForm({ onDone }: { onDone: () => void }) {
  const { workspace } = useWorkspace()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const products = useProducts()
  const [customer, setCustomer] = useState('')
  const [contact, setContact] = useState('')
  const [currency, setCurrency] = useState<Currency>('RUB')
  const [due, setDue] = useState('')
  const [note, setNote] = useState('')
  const [rows, setRows] = useState<Row[]>([{ product: '', qty: '1', price: '' }])
  const upd = (i: number, k: keyof Row, v: string) => setRows(r => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  const priceHint = (id: string) => {
    const p = products.data?.find(x => x.id === id)
    return p && p.price_currency === currency ? (p.actual_price ?? p.planned_price) : null
  }

  const create = useMutation({
    mutationFn: () => {
      const items = rows.filter(r => r.product).map(r => {
        const qty = parseAmount(r.qty)
        if (!Number.isFinite(qty) || qty <= 0) throw new Error('Количество должно быть больше нуля')
        const price = r.price.trim() ? parseAmount(r.price) : undefined
        if (price !== undefined && (!Number.isFinite(price) || price < 0)) throw new Error('Цена — неотрицательное число')
        return { product_id: r.product, qty, ...(price !== undefined ? { price } : {}) }
      })
      if (!items.length) throw new Error('Выберите хотя бы одно изделие')
      return createSale(workspace.id, { customer: customer.trim(), contact: contact.trim(), currency, due: due || null, note: note.trim(), items })
    },
    onSuccess: id => { qc.invalidateQueries({ queryKey: ['sales'] }); qc.invalidateQueries({ queryKey: ['activity'] }); onDone(); nav(`/sales/${id}`) },
    onError: e => toast(errMsg(e), 'error'),
  })
  const submit = (e: FormEvent) => { e.preventDefault(); if (customer.trim()) create.mutate() }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Клиент"><input className="dash-input" required autoFocus value={customer} onChange={e => setCustomer(e.target.value)} maxLength={200} placeholder="ООО «Радиосвязь»" /></Field>
        <Field label="Контакт"><input className="dash-input" value={contact} onChange={e => setContact(e.target.value)} maxLength={300} placeholder="Телефон, telegram, email" /></Field>
        <Field label="Валюта заказа">
          <select className="dash-input" value={currency} onChange={e => setCurrency(e.target.value as Currency)}>
            {CURRENCIES.map(c => <option key={c.id} value={c.id}>{c.id}</option>)}
          </select>
        </Field>
        <Field label="Срок"><DateInput min={todayIso()} value={due} onChange={setDue} /></Field>
      </div>
      <div>
        <div className="dash-label mb-1.5">Позиции</div>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_4.5rem_6.5rem_2rem] gap-2">
              <select className="dash-input" value={r.product} onChange={e => upd(i, 'product', e.target.value)} aria-label="Изделие">
                <option value="">Изделие…</option>
                {products.data?.map(p => <option key={p.id} value={p.id}>{p.name}{p.version ? ` ${p.version}` : ''}</option>)}
              </select>
              <input className="dash-input text-right" inputMode="decimal" value={r.qty} onChange={e => upd(i, 'qty', e.target.value)} aria-label="Количество" />
              <input className="dash-input text-right" inputMode="decimal" value={r.price} onChange={e => upd(i, 'price', e.target.value)} aria-label="Цена за штуку"
                placeholder={priceHint(r.product) !== null ? String(priceHint(r.product)) : 'цена'} />
              <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !px-1" aria-label="Убрать позицию" disabled={rows.length === 1} onClick={() => setRows(x => x.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
            </div>
          ))}
        </div>
        <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm mt-2" onClick={() => setRows(r => [...r, { product: '', qty: '1', price: '' }])}><Plus className="h-4 w-4" aria-hidden /> Позиция</button>
        <p className="dash-muted mt-1 text-xs">Цена пустая — подставится из карточки изделия (если она в валюте заказа), иначе впишите после создания.</p>
      </div>
      <Field label="Примечание"><textarea className="dash-input" rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={2000} /></Field>
      <div className="flex justify-end gap-2">
        <button type="button" className="dash-btn dash-btn-ghost" onClick={onDone}>Отмена</button>
        <button className="dash-btn" disabled={create.isPending || !customer.trim()}>{create.isPending ? 'Создаём…' : 'Создать заказ'}</button>
      </div>
    </form>
  )
}

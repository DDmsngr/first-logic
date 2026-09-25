import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useWorkspace } from '../auth'
import { fetchAllComponents } from '../catalog'
import { useRates, useSuppliers } from '../catalogParts'
import { fmtDate, todayIso } from '../meta'
import { fmtMoney, parseAmount } from '../money'
import { purchaseOrderRub } from '../orders'
import { ORDER_STATUSES, createOrder, fetchOrders, type OrderStatus } from '../stock'
import { DateInput, Field, Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'

export function OrderStatusChip({ status }: { status: OrderStatus }) {
  const s = ORDER_STATUSES.find(x => x.id === status)!
  return <span className="dash-chip" style={{ color: s.color, borderColor: `${s.color}55` }}>{s.label}</span>
}

export default function Orders() {
  const { workspace } = useWorkspace()
  const [sp, setSp] = useSearchParams()
  const [creating, setCreating] = useState(false)
  const status = sp.get('status') ?? 'open' // open | all | статус заказа
  const sup = sp.get('sup') ?? ''
  const list = useQuery({ queryKey: ['orders', workspace.id], queryFn: () => fetchOrders(workspace.id) })
  const sups = useSuppliers()
  const rates = useRates()
  const supName = (id: string | null) => (id ? sups.data?.find(s => s.id === id)?.name ?? '—' : 'Без поставщика')
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }) }

  const all = list.data ?? []
  const items = all.filter(o => (status === 'open' ? o.status === 'draft' || o.status === 'ordered' : status === 'all' || o.status === status)
    && (!sup || o.supplier_id === sup))
  const count = (s: OrderStatus) => all.filter(o => o.status === s).length
  const today = todayIso()

  const TABS: { id: string; label: string; n?: number }[] = [
    { id: 'open', label: 'Открытые', n: count('draft') + count('ordered') },
    ...ORDER_STATUSES.map(s => ({ id: s.id, label: s.label, n: count(s.id) })),
    { id: 'all', label: 'Все', n: all.length },
  ]

  return (
    <>
      <PageHeader title="Заказы поставщикам" sub="Черновик → отправлен поставщику → принят: при приёмке растёт склад, обновляется цена и записывается расход."
        actions={<button className="dash-btn" onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Новый заказ</button>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Статус">
          {TABS.map(t => (
            <button key={t.id} role="tab" aria-selected={status === t.id} onClick={() => setParam('status', t.id === 'open' ? '' : t.id)}
              className={`dash-btn dash-btn-sm ${status === t.id ? '' : 'dash-btn-ghost'}`}>{t.label}{t.n ? <span className="tabular-nums opacity-70"> {t.n}</span> : null}</button>
          ))}
        </div>
        <select className="dash-input ml-auto !w-auto" value={sup} onChange={e => setParam('sup', e.target.value)} aria-label="Поставщик">
          <option value="">Все поставщики</option>
          {sups.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} empty={items.length === 0}
        emptyText={all.length ? 'Под фильтр ничего не подходит' : 'Заказов пока нет'}
        emptyHint={all.length ? undefined : 'Создайте заказ кнопкой сверху или из выгрузки «что докупить» на странице компонентов'}>
        <ul className="grid gap-2">
          {items.map(o => {
            const r = purchaseOrderRub(o.items, rates.data ?? [])
            const late = o.status === 'ordered' && o.expected_on && o.expected_on < today
            return (
              <li key={o.id}>
                <Link to={`/orders/${o.id}`} className="dash-card flex flex-wrap items-center gap-x-4 gap-y-1 p-3 transition-colors hover:border-[var(--d-line-strong)]">
                  <span className="dash-mono w-12 text-sm text-[var(--d-accent)]">№{o.num}</span>
                  <span className="min-w-0 flex-1 basis-48 truncate font-medium">{supName(o.supplier_id)}</span>
                  <OrderStatusChip status={o.status} />
                  <span className="dash-muted w-20 text-right text-sm tabular-nums">{o.items.length} поз.</span>
                  <span className="w-28 text-right text-sm tabular-nums">≈ {fmtMoney(r.sum, 'RUB')}</span>
                  <span className={`w-32 text-right text-xs ${late ? 'text-[var(--d-warn)]' : 'dash-muted'}`}>
                    {o.status === 'received' ? `принят ${fmtDate(o.received_at)}` : o.expected_on ? `${late ? 'опаздывает, ' : 'ждём '}${fmtDate(o.expected_on)}` : `создан ${fmtDate(o.created_at)}`}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </QueryState>

      {creating && <NewOrderModal onClose={() => setCreating(false)} />}
    </>
  )
}

/** Новый заказ вручную: поставщик и позиции из справочника компонентов. */
function NewOrderModal({ onClose }: { onClose: () => void }) {
  const { workspace } = useWorkspace()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const sups = useSuppliers()
  const comps = useQuery({ queryKey: ['components', workspace.id, 'all'], queryFn: () => fetchAllComponents(workspace.id) })
  const [supplier, setSupplier] = useState('')
  const [expected, setExpected] = useState('')
  const [q, setQ] = useState('')
  const [lines, setLines] = useState<{ id: string; qty: string }[]>([])

  const available = useMemo(() => (comps.data ?? []).filter(c => !c.archived_at && !lines.some(l => l.id === c.id)), [comps.data, lines])
  // сначала компоненты этого поставщика
  const needle = q.trim().toLowerCase()
  const matches = available.filter(c => !needle || `${c.name} ${c.sku ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.supplier_id === supplier) - Number(a.supplier_id === supplier) || a.name.localeCompare(b.name, 'ru')).slice(0, 8)
  const byId = new Map((comps.data ?? []).map(c => [c.id, c]))

  const create = useMutation({
    mutationFn: () => {
      const bad = lines.find(l => !(parseAmount(l.qty) > 0))
      if (bad) throw new Error(`Количество у «${byId.get(bad.id)?.name}» должно быть больше нуля`)
      return createOrder(workspace.id, supplier || null, lines.map(l => ({ component_id: l.id, qty: parseAmount(l.qty) })), '', expected || null)
    },
    onSuccess: id => { qc.invalidateQueries({ queryKey: ['orders'] }); toast('Заказ создан — это черновик, его можно поправить'); onClose(); nav(`/orders/${id}`) },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <Modal open onClose={onClose} title="Новый заказ поставщику">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Поставщик">
            <select className="dash-input" value={supplier} onChange={e => setSupplier(e.target.value)}>
              <option value="">Не указан</option>
              {sups.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Ожидаем к" hint="Необязательно"><DateInput value={expected} onChange={setExpected} min={todayIso()} /></Field>
        </div>
        <Field label="Добавить позицию">
          <input className="dash-input" placeholder="Название или артикул компонента" value={q} onChange={e => setQ(e.target.value)} />
        </Field>
        {needle && (
          <ul className="max-h-48 overflow-y-auto rounded-md border border-[var(--d-line-strong)] bg-[var(--d-raised)] p-1">
            {matches.map(c => (
              <li key={c.id}><button type="button" className="flex w-full justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--d-surface)]"
                onClick={() => { setLines(l => [...l, { id: c.id, qty: String(Math.max(1, c.min_stock - c.stock) || 1) }]); setQ('') }}>
                <span className="truncate">{c.name}</span><span className="dash-muted shrink-0 text-xs">есть {c.stock} {c.unit}</span>
              </button></li>
            ))}
            {matches.length === 0 && <li className="dash-muted px-2 py-1.5 text-sm">Не найдено</li>}
          </ul>
        )}
        {lines.length > 0 && (
          <ul className="rounded-md border border-[var(--d-line)] text-sm">
            {lines.map(l => (
              <li key={l.id} className="dash-row flex items-center gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate">{byId.get(l.id)?.name}</span>
                <input className="dash-input !min-h-8 !w-20 text-right" inputMode="decimal" value={l.qty} aria-label="Количество"
                  onChange={e => setLines(ls => ls.map(x => (x.id === l.id ? { ...x, qty: e.target.value } : x)))} />
                <span className="dash-muted w-8 text-xs">{byId.get(l.id)?.unit}</span>
                <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setLines(ls => ls.filter(x => x.id !== l.id))} aria-label="Убрать">×</button>
              </li>
            ))}
          </ul>
        )}
        <p className="dash-muted text-xs">Цены подставятся сами: предложение этого поставщика, а если его нет — цена из карточки компонента. В черновике их можно поправить.</p>
        <div className="flex justify-end gap-2 pt-1">
          <button className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
          <button className="dash-btn" disabled={lines.length === 0 || create.isPending} onClick={() => create.mutate()}>Создать заказ</button>
        </div>
      </div>
    </Modal>
  )
}

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Unlock } from 'lucide-react'
import { useWorkspace } from './auth'
import { fmtDateTime } from './meta'
import { fmtQty, parseAmount } from './money'
import { fetchComponentReservations, fetchReserved, fetchTargetReservations, releaseReservation, reserve } from './stock'
import { QueryState, errMsg, useToast } from './ui'

export function useReserved() {
  const { workspace } = useWorkspace()
  return useQuery({ queryKey: ['reserved', workspace.id], queryFn: fetchReserved, staleTime: 30_000 })
}

/** «В резерве 30 · доступно 10» под остатком; ничего не рисует, если резерва нет. */
export function ReservedNote({ id, stock, unit }: { id: string; stock: number; unit: string }) {
  const r = useReserved().data?.get(id) ?? 0
  if (r <= 0) return null
  const free = stock - r
  return (
    <span className="dash-muted block text-xs tabular-nums" title="Резерв — запас, обещанный под запланированные сборки">
      резерв {fmtQty(r)} · <span className={free < 0 ? 'text-[var(--d-danger)]' : ''}>доступно {fmtQty(free)}</span> {unit}
    </span>
  )
}

type Target = { productId: string; assemblyId?: never } | { assemblyId: string; productId?: never }

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  ['reserved', 'reservations', 'component-reservations', 'activity'].forEach(k => qc.invalidateQueries({ queryKey: [k] }))

/** Резерв под запланированную сборку: склад не меняется, но запас помечен как обещанный. */
export function ReservePanel({ target }: { target: Target }) {
  const { byUser } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [units, setUnits] = useState('1')
  const [note, setNote] = useState('')
  const list = useQuery({ queryKey: ['reservations', target.productId ?? target.assemblyId], queryFn: () => fetchTargetReservations(target) })
  const n = parseAmount(units)
  const valid = Number.isFinite(n) && n > 0

  const add = useMutation({
    mutationFn: () => reserve(target, n, note.trim()),
    onSuccess: () => { toast(`Зарезервировано под ${fmtQty(n)} шт`); setNote(''); invalidate(qc) },
    onError: e => toast(errMsg(e), 'error'),
  })
  const drop = useMutation({
    mutationFn: releaseReservation,
    onSuccess: () => { toast('Резерв снят'); invalidate(qc) },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <div className="mt-4 border-t border-[var(--d-line)] pt-3">
      <h3 className="dash-label mb-2">Резерв под сборку</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="dash-label mb-1.5 block">Под, шт</span>
          <input className="dash-input !w-24 text-right" inputMode="decimal" value={units} onChange={e => setUnits(e.target.value)} aria-label="Сколько зарезервировать" />
        </label>
        <label className="min-w-40 flex-1 text-sm">
          <span className="dash-label mb-1.5 block">Для чего</span>
          <input className="dash-input" placeholder="Заказ клиента, партия" value={note} onChange={e => setNote(e.target.value)} />
        </label>
        <button className="dash-btn dash-btn-ghost" disabled={!valid || add.isPending} onClick={() => add.mutate()}><Lock className="h-4 w-4" aria-hidden /> Зарезервировать</button>
      </div>
      <p className="dash-muted mt-1.5 text-xs">Склад не меняется: в списке компонентов появится «в резерве» и «доступно». Когда вы соберёте изделие, резерв уменьшится сам.</p>
      <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} empty={list.data?.length === 0} emptyText="Активных резервов нет">
        <ul className="mt-2 text-sm">
          {list.data?.map(r => (
            <li key={r.id} className="dash-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <b className="tabular-nums">{fmtQty(r.units)} шт</b>
              <span className="min-w-0 flex-1 truncate">{r.note || '—'}</span>
              <span className="dash-muted text-xs">{byUser(r.created_by)?.name ?? '—'} · {fmtDateTime(r.created_at)}</span>
              <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={drop.isPending} onClick={() => confirm('Снять резерв?') && drop.mutate(r.id)}><Unlock className="h-4 w-4" aria-hidden /> Снять</button>
            </li>
          ))}
        </ul>
      </QueryState>
    </div>
  )
}

/** На карточке компонента: под какие сборки он сейчас зарезервирован. */
export function ComponentReservations({ componentId, unit }: { componentId: string; unit: string }) {
  const q = useQuery({ queryKey: ['component-reservations', componentId], queryFn: () => fetchComponentReservations(componentId) })
  if (!q.data?.length) return null
  return (
    <section className="dash-card mb-4 p-4" aria-label="Резервы">
      <h2 className="dash-label mb-2">В резерве</h2>
      <ul className="text-sm">
        {q.data.map(({ qty, r }) => (
          <li key={r.id} className="dash-row flex flex-wrap items-center gap-x-3 py-1.5">
            <Link className="font-medium hover:underline" to={r.product_id ? `/products/${r.product_id}` : `/assemblies/${r.assembly_id}`}>{r.title}</Link>
            <span className="dash-muted">× {fmtQty(r.units)}{r.note ? ` · ${r.note}` : ''}</span>
            <span className="ml-auto tabular-nums">{fmtQty(qty)} {unit}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

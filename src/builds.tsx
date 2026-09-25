import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Hammer, Undo2 } from 'lucide-react'
import { useWorkspace } from './auth'
import { useCosting } from './catalogParts'
import { fmtDateTime } from './meta'
import { fmtQty, parseAmount } from './money'
import { build, fetchBuilds, revertBuild } from './stock'
import { QueryState, errMsg, useToast } from './ui'

type Target = { productId: string; assemblyId?: never } | { assemblyId: string; productId?: never }

/** «Собрал N штук»: списание компонентов по составу, история сборок с отменой. */
export function BuildPanel({ target }: { target: Target }) {
  const { byUser } = useWorkspace()
  const c = useCosting()
  const qc = useQueryClient()
  const toast = useToast()
  const [qty, setQty] = useState('1')
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState(false)
  const builds = useQuery({ queryKey: ['builds', target.productId ?? target.assemblyId], queryFn: () => fetchBuilds(target) })

  const n = parseAmount(qty)
  const valid = Number.isFinite(n) && n > 0
  const need = c.k && valid ? c.k.explode(target, n) : new Map<string, number>()
  const lines = [...need.entries()].map(([id, q]) => {
    const comp = c.components.find(x => x.id === id)
    return { id, name: comp?.name ?? '—', unit: comp?.unit ?? 'шт', q, stock: comp?.stock ?? 0 }
  }).sort((a, b) => (a.stock - a.q) - (b.stock - b.q))
  const negative = lines.filter(l => l.stock - l.q < 0)

  const refresh = () => ['builds', 'components', 'component', 'activity', 'bom', 'reserved', 'reservations', 'component-reservations'].forEach(k => qc.invalidateQueries({ queryKey: [k] }))
  const run = useMutation({
    mutationFn: () => build(target, n, note.trim()),
    onSuccess: () => { toast(`Списано со склада: ${lines.length} позиций на ${fmtQty(n)} шт`); setPreview(false); setNote(''); refresh() },
    onError: e => toast(errMsg(e), 'error'),
  })
  const revert = useMutation({
    mutationFn: revertBuild,
    onSuccess: () => { toast('Сборка отменена, компоненты вернулись на склад'); refresh() },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="dash-label mb-1.5 block">Собрали, шт</span>
          <input className="dash-input !w-24 text-right" inputMode="decimal" value={qty} onChange={e => { setQty(e.target.value); setPreview(false) }} aria-label="Сколько собрали" />
        </label>
        <label className="min-w-40 flex-1 text-sm">
          <span className="dash-label mb-1.5 block">Комментарий</span>
          <input className="dash-input" placeholder="Партия, серийные номера, заказчик" value={note} onChange={e => setNote(e.target.value)} />
        </label>
        <button className="dash-btn" disabled={!valid || lines.length === 0 || c.loading} onClick={() => setPreview(true)}>
          <Hammer className="h-4 w-4" aria-hidden /> Списать со склада…
        </button>
      </div>
      {!c.loading && lines.length === 0 && <p className="dash-muted mt-2 text-sm">Состав пуст — списывать нечего. Сначала заполните состав.</p>}

      {preview && lines.length > 0 && (
        <div className="mt-3 rounded-lg border border-[var(--d-line-strong)] bg-black/20 p-3" role="region" aria-label="Что будет списано">
          <div className="mb-2 text-sm font-medium">Будет списано на {fmtQty(n)} шт — {lines.length} позиций</div>
          {negative.length > 0 && (
            <p className="mb-2 flex items-center gap-1.5 text-sm text-[var(--d-warn)]">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              У {negative.length} позиций остаток уйдёт в минус. Если детали на самом деле есть — сначала поправьте остаток.
            </p>
          )}
          <ul className="max-h-56 overflow-y-auto text-sm">
            {lines.map(l => (
              <li key={l.id} className="dash-row flex items-center gap-3 py-1.5">
                <Link to={`/components/${l.id}`} className="min-w-0 flex-1 truncate hover:underline">{l.name}</Link>
                <span className="tabular-nums">−{fmtQty(l.q)} {l.unit}</span>
                <span className={`w-28 text-right tabular-nums ${l.stock - l.q < 0 ? 'text-[var(--d-warn)]' : 'dash-muted'}`}>
                  {fmtQty(l.stock)} → {fmtQty(l.stock - l.q)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end gap-2">
            <button className="dash-btn dash-btn-ghost" onClick={() => setPreview(false)}>Отмена</button>
            <button className="dash-btn" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Списываем…' : 'Подтвердить списание'}</button>
          </div>
        </div>
      )}

      <h3 className="dash-label mb-1 mt-5">Последние сборки</h3>
      <QueryState loading={builds.isLoading} error={builds.error} onRetry={() => builds.refetch()} empty={builds.data?.length === 0} emptyText="Сборок ещё не было">
        <ul className="text-sm">
          {builds.data?.map(b => (
            <li key={b.id} className={`dash-row flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 ${b.reverted_at ? 'opacity-50' : ''}`}>
              <span className="font-medium tabular-nums">{fmtQty(b.qty)} шт</span>
              <span className="dash-muted">{fmtDateTime(b.created_at)} · {byUser(b.created_by)?.name ?? '—'} · {b.lines.length} поз.</span>
              {b.note && <span className="min-w-0 flex-1 truncate">{b.note}</span>}
              <span className="ml-auto">
                {b.reverted_at
                  ? <span className="dash-chip">отменена</span>
                  : <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={revert.isPending}
                      onClick={() => confirm(`Отменить сборку ${fmtQty(b.qty)} шт? Все ${b.lines.length} позиций вернутся на склад.`) && revert.mutate(b.id)}>
                      <Undo2 className="h-3.5 w-3.5" aria-hidden /> Отменить
                    </button>}
              </span>
            </li>
          ))}
        </ul>
      </QueryState>
    </div>
  )
}

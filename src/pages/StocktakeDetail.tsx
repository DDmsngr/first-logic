import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, Trash2 } from 'lucide-react'
import { fmtQty, parseAmount } from '../money'
import { fmtDateTime } from '../meta'
import { applyStocktake, cancelStocktake, deleteStocktake, fetchStocktake, setCounted, type StocktakeLine } from '../stock'
import { Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'
import { STOCKTAKE_STATUS } from './Stocktake'

type Tab = 'all' | 'todo' | 'diff'

const diffOf = (l: StocktakeLine) => (l.counted === null ? null : Math.round((l.counted - l.expected) * 1000) / 1000)

export default function StocktakeDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['stocktake', id], queryFn: () => fetchStocktake(id) })
  const [tab, setTab] = useState<Tab>('all')
  const [search, setSearch] = useState('')
  const [confirm, setConfirm] = useState(false)
  const s = q.data
  const draft = s?.status === 'draft'
  const lines = s?.lines ?? []

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['stocktake', id] }); void qc.invalidateQueries({ queryKey: ['stocktakes'] }) }
  const save = useMutation({
    mutationFn: ({ line, value }: { line: string; value: number | null }) => setCounted(line, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stocktake', id] }),
    onError: e => { toast(errMsg(e), 'error'); refresh() },
  })
  const apply = useMutation({
    mutationFn: () => applyStocktake(id),
    onSuccess: r => {
      toast(`Готово: изменено ${r.changed}, совпало ${r.same}${r.moved ? `, ещё ${r.moved} менялись во время подсчёта` : ''}`)
      setConfirm(false); refresh()
      for (const k of ['components', 'activity']) void qc.invalidateQueries({ queryKey: [k] })
    },
    onError: e => toast(errMsg(e), 'error'),
  })
  const drop = useMutation({
    mutationFn: () => (draft && lines.some(l => l.counted !== null) ? cancelStocktake(id) : deleteStocktake(id)),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['stocktakes'] }); nav('/stocktake') },
    onError: e => toast(errMsg(e), 'error'),
  })

  const counted = lines.filter(l => l.counted !== null)
  const diffs = counted.filter(l => diffOf(l) !== 0)
  const shown = useMemo(() => {
    const t = search.trim().toLowerCase()
    return lines.filter(l =>
      (tab === 'all' || (tab === 'todo' ? l.counted === null : (diffOf(l) ?? 0) !== 0))
      && (!t || `${l.name} ${l.sku ?? ''} ${l.location ?? ''}`.toLowerCase().includes(t)))
  }, [lines, tab, search])

  if (!s) return <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty emptyText="Инвентаризация не найдена"><></></QueryState>
  const meta = STOCKTAKE_STATUS[s.status]

  return (
    <div className="mx-auto max-w-4xl pb-24">
      <Link to="/stocktake" className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> Инвентаризации</Link>
      <PageHeader title={`Инвентаризация №${s.num}${s.title ? ` · ${s.title}` : ''}`}
        sub={<span className="flex flex-wrap items-center gap-2">
          <span className="dash-chip" style={{ color: meta.color, borderColor: `${meta.color}66` }}>{meta.label}</span>
          <span>{s.status === 'applied' ? `применена ${fmtDateTime(s.applied_at ?? s.created_at)}` : `начата ${fmtDateTime(s.created_at)}`}</span>
        </span>}
        actions={s.status !== 'applied' && (
          <button className="dash-btn dash-btn-ghost" disabled={drop.isPending}
            onClick={() => confirmDrop(counted.length) && drop.mutate()}><Trash2 className="h-4 w-4" aria-hidden /> {counted.length ? 'Отменить' : 'Удалить'}</button>
        )} />

      <div className="dash-card mb-3 p-3">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span>Посчитано <b className="tabular-nums">{counted.length}</b> из <b className="tabular-nums">{lines.length}</b></span>
          <span className={diffs.length ? 'text-[var(--d-warn)]' : 'dash-muted'}>расхождений: {diffs.length}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-black/30" role="progressbar" aria-valuemin={0} aria-valuemax={lines.length} aria-valuenow={counted.length}>
          <div className="h-full bg-[var(--d-accent)] transition-all" style={{ width: `${lines.length ? (counted.length / lines.length) * 100 : 0}%` }} />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Показать">
          {([['all', 'Все'], ['todo', 'Не посчитано'], ['diff', 'Расхождения']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`dash-btn dash-btn-sm ${tab === k ? '' : 'dash-btn-ghost'}`}>{l}</button>
          ))}
        </div>
        <input className="dash-input !w-auto min-w-40 flex-1" type="search" placeholder="Название, артикул, место" value={search} onChange={e => setSearch(e.target.value)} aria-label="Поиск" />
      </div>

      <ul className="dash-card divide-y divide-[var(--d-line)]" data-testid="stocktake-lines">
        {shown.length === 0 && <li className="dash-muted px-4 py-6 text-center text-sm">{lines.length ? 'По фильтру ничего нет' : 'Список пуст'}</li>}
        {shown.map(l => (
          <Row key={l.id} line={l} editable={draft} saving={save.isPending && save.variables?.line === l.id}
            onSave={v => save.mutate({ line: l.id, value: v })} />
        ))}
      </ul>

      {draft && (
        <div className="dash-safe-bottom fixed inset-x-0 bottom-[3.75rem] z-30 border-t border-[var(--d-line)] bg-[var(--d-surface)]/95 px-4 py-2.5 backdrop-blur md:bottom-0 md:left-60">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <span className="dash-muted text-sm">{counted.length ? `К применению: ${diffs.length} из ${counted.length}` : 'Введите пересчитанные количества'}</span>
            <button className="dash-btn" disabled={!counted.length} onClick={() => setConfirm(true)}><Check className="h-4 w-4" aria-hidden /> Применить</button>
          </div>
        </div>
      )}

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Применить инвентаризацию?" guard={false}>
        <p className="mb-2 text-sm">Остатки посчитанных позиций станут равны пересчёту, в истории каждого компонента появится пометка «Инвентаризация №{s.num}». Позиции без пересчёта не меняются. Отменить нельзя.</p>
        {diffs.length === 0
          ? <p className="dash-muted mb-3 text-sm">Расхождений нет: все посчитанные позиции совпали с учётом.</p>
          : (
            <ul className="mb-3 max-h-64 overflow-y-auto rounded-md border border-[var(--d-line)] text-sm">
              {diffs.map(l => (
                <li key={l.id} className="dash-row flex items-center gap-2 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  <span className="dash-muted tabular-nums">{fmtQty(l.expected)} → <b className="text-[var(--d-text)]">{fmtQty(l.counted)}</b> {l.unit}</span>
                </li>
              ))}
            </ul>
          )}
        <div className="flex justify-end gap-2">
          <button className="dash-btn dash-btn-ghost" onClick={() => setConfirm(false)}>Назад</button>
          <button className="dash-btn" disabled={apply.isPending} onClick={() => apply.mutate()}>{apply.isPending ? 'Применяем…' : 'Применить'}</button>
        </div>
      </Modal>
    </div>
  )
}

const confirmDrop = (counted: number) => confirm(counted ? 'Отменить инвентаризацию? Введённые пересчёты не применятся, остатки не изменятся.' : 'Удалить пустую инвентаризацию?')

function Row({ line: l, editable, saving, onSave }: { line: StocktakeLine; editable: boolean; saving: boolean; onSave: (v: number | null) => void }) {
  const [val, setVal] = useState(l.counted === null ? '' : String(l.counted).replace('.', ','))
  const [bad, setBad] = useState(false)
  const d = diffOf(l)

  const commit = (raw: string) => {
    const t = raw.trim()
    if (!t) { setBad(false); if (l.counted !== null) onSave(null); return }
    const n = parseAmount(t)
    if (!Number.isFinite(n) || n < 0) { setBad(true); return }
    setBad(false)
    if (n !== l.counted) onSave(n)
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <div className="font-medium leading-snug">{l.name}</div>
        <div className="dash-muted text-xs">{[l.sku, l.location].filter(Boolean).join(' · ') || '—'}</div>
      </div>
      <div className="text-right text-sm">
        <div className="dash-muted text-xs">по учёту</div>
        <div className="tabular-nums">{fmtQty(l.expected)} {l.unit}</div>
      </div>
      {editable ? (
        <div className="flex items-center gap-1.5">
          <input className={`dash-input !w-24 text-right text-base ${bad ? '!border-[var(--d-danger)]' : ''}`} inputMode="decimal" aria-label={`Посчитано: ${l.name}`}
            value={val} placeholder="—" onChange={e => setVal(e.target.value)} onBlur={e => commit(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
          <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !px-2" title="Совпадает с учётом" aria-label={`${l.name}: совпадает с учётом`}
            onClick={() => { const v = String(l.expected).replace('.', ','); setVal(v); onSave(l.expected) }}><Check className="h-4 w-4" aria-hidden /></button>
        </div>
      ) : (
        <div className="w-24 text-right tabular-nums">{l.counted === null ? '—' : `${fmtQty(l.counted)} ${l.unit}`}</div>
      )}
      <div className="w-16 text-right text-sm tabular-nums" aria-live="polite">
        {saving ? <span className="dash-muted">…</span>
          : d === null ? null
          : d === 0 ? <span className="text-[var(--d-ok)]">✓</span>
          : <span className={d > 0 ? 'text-[var(--d-ok)]' : 'text-[var(--d-danger)]'}>{d > 0 ? '+' : ''}{fmtQty(d)}</span>}
      </div>
    </li>
  )
}

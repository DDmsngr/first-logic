import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, Plus } from 'lucide-react'
import { useWorkspace } from '../auth'
import { useDicts } from '../catalogParts'
import { fmtDateTime } from '../meta'
import { fetchStocktakes, startStocktake, type Stocktake } from '../stock'
import { Field, Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'

export const STOCKTAKE_STATUS: Record<Stocktake['status'], { label: string; color: string }> = {
  draft: { label: 'Идёт подсчёт', color: '#f2b94b' },
  applied: { label: 'Применена', color: '#5fd08f' },
  cancelled: { label: 'Отменена', color: '#6b7785' },
}

export default function StocktakeList() {
  const { workspace, byUser } = useWorkspace()
  const [creating, setCreating] = useState(false)
  const list = useQuery({ queryKey: ['stocktakes', workspace.id], queryFn: () => fetchStocktakes(workspace.id) })

  return (
    <>
      <PageHeader title="Инвентаризация" sub="Пересчитали склад руками — система покажет расхождения и исправит остатки с пометкой в истории."
        actions={<button className="dash-btn" onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Новая инвентаризация</button>} />
      <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} empty={list.data?.length === 0}
        emptyText="Инвентаризаций ещё не было" emptyHint="Начните с одной полки или ящика: выберите место хранения и пересчитайте только его">
        <ul className="dash-card divide-y divide-[var(--d-line)]">
          {list.data?.map(s => {
            const done = s.lines?.filter(l => l.counted !== null).length ?? 0
            const meta = STOCKTAKE_STATUS[s.status]
            return (
              <li key={s.id}>
                <Link to={`/stocktake/${s.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-white/5">
                  <span className="dash-mono">№{s.num}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{s.title || 'Без названия'}</span>
                  <span className="dash-chip" style={{ color: meta.color, borderColor: `${meta.color}66` }}>{meta.label}</span>
                  <span className="dash-muted w-full text-xs sm:w-auto">
                    посчитано {done} из {s.lines?.length ?? 0} · {byUser(s.created_by)?.name ?? '—'} · {fmtDateTime(s.applied_at ?? s.created_at)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </QueryState>
      <Modal open={creating} onClose={() => setCreating(false)} title="Новая инвентаризация">
        {creating && <StartForm onDone={() => setCreating(false)} />}
      </Modal>
    </>
  )
}

function StartForm({ onDone }: { onDone: () => void }) {
  const { workspace } = useWorkspace()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const cats = useDicts('component_category')
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('')
  const [location, setLocation] = useState('')
  const start = useMutation({
    mutationFn: () => startStocktake(workspace.id, { title, category, location }),
    onSuccess: id => { qc.invalidateQueries({ queryKey: ['stocktakes'] }); onDone(); nav(`/stocktake/${id}`) },
    onError: e => toast(errMsg(e), 'error'),
  })
  const submit = (e: FormEvent) => { e.preventDefault(); start.mutate() }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="dash-muted text-sm">Фиксируется снимок остатков «по учёту». Заведите условия так, чтобы пересчитать за один подход: всё, одну категорию или одно место хранения.</p>
      <Field label="Название" hint="Необязательно, например «Шкаф 1» или «Годовая»">
        <input className="dash-input" autoFocus value={title} onChange={e => setTitle(e.target.value)} maxLength={120} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Категория">
          <select className="dash-input" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">Все</option>
            {cats.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Место хранения содержит" hint="«Шкаф 1» найдёт «Шкаф 1, ящик 3»">
          <input className="dash-input" value={location} onChange={e => setLocation(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="dash-btn dash-btn-ghost" onClick={onDone}>Отмена</button>
        <button className="dash-btn" disabled={start.isPending}><ClipboardCheck className="h-4 w-4" aria-hidden /> {start.isPending ? 'Готовим список…' : 'Начать подсчёт'}</button>
      </div>
    </form>
  )
}

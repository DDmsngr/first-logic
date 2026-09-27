import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Link2, Link2Off, ListChecks, Plus } from 'lucide-react'
import {
  addSubtasks, attachSubtasks, detachSubtask, fetchSubtasks, fetchTask, fetchTasks, updateTask,
} from './api'
import { useWorkspace } from './auth'
import type { Task } from './types'
import { Avatar, Modal, QueryState, errMsg, useToast } from './ui'
import { DueLabel, PriorityChip } from './taskParts'

const REFRESH_KEYS = ['tasks', 'task', 'stats', 'activity']

/** «Подзадача задачи #N Название» — ссылка наверх, когда открыли саму подзадачу напрямую. */
export function SubtaskBreadcrumb({ parentId }: { parentId: string }) {
  const q = useQuery({ queryKey: ['task', parentId], queryFn: () => fetchTask(parentId) })
  if (!q.data) return null
  return (
    <Link to={`/tasks/${parentId}`} className="dash-muted mb-2 inline-flex items-center gap-1.5 text-xs hover:text-[var(--d-text)]">
      <ListChecks className="h-3.5 w-3.5" aria-hidden /> Подзадача «#{q.data.num} {q.data.title}»
    </Link>
  )
}

/** Чек-лист подзадач внутри карточки родительской задачи. У подзадачи своих подзадач не бывает. */
export function SubtasksPanel({ task }: { task: Task }) {
  const { isAdmin, userId, byUser } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [attaching, setAttaching] = useState(false)

  const list = useQuery({ queryKey: ['subtasks', task.id], queryFn: () => fetchSubtasks(task.id) })
  const rows = list.data ?? []
  const done = rows.filter(t => t.status === 'done').length

  const refresh = () => {
    REFRESH_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }))
    qc.invalidateQueries({ queryKey: ['subtasks', task.id] })
  }

  const toggle = useMutation({
    mutationFn: (t: Task) => updateTask(t.id, { status: t.status === 'done' ? 'todo' : 'done' }),
    onSuccess: refresh,
    onError: e => { toast(errMsg(e), 'error'); refresh() },
  })
  const detach = useMutation({
    mutationFn: (id: string) => detachSubtask(id),
    onSuccess: () => { toast('Откреплена'); refresh() },
    onError: e => toast(errMsg(e), 'error'),
  })

  if (task.parent_id) return null

  return (
    <section aria-labelledby="sub-h" className="mb-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="sub-h" className="dash-label">Подзадачи{rows.length > 0 ? ` · ${done}/${rows.length}` : ''}</h2>
        {isAdmin && (
          <div className="flex gap-2">
            <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setAttaching(true)}>
              <Link2 className="h-4 w-4" aria-hidden /> Прикрепить существующую
            </button>
            <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Добавить
            </button>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-[var(--d-line)]" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={rows.length}>
          <div className="h-full bg-[var(--d-ok)] transition-all" style={{ width: `${(done / rows.length) * 100}%` }} />
        </div>
      )}

      <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()}
        empty={rows.length === 0} emptyText="Подзадач нет"
        emptyHint={isAdmin ? 'Добавьте список проверок кнопкой «Добавить» или прикрепите уже созданные задачи.' : undefined}>
        <ul className="dash-card divide-y divide-[var(--d-line)]">
          {rows.map(t => {
            const canCheck = isAdmin || t.assignee_id === userId
            return (
              <li key={t.id} className="flex items-center gap-2.5 px-3 py-2">
                <button type="button" disabled={!canCheck || toggle.isPending}
                  aria-label={t.status === 'done' ? `Снять отметку с «${t.title}»` : `Отметить «${t.title}» выполненной`}
                  onClick={() => toggle.mutate(t)}
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-colors disabled:cursor-default disabled:opacity-40 ${
                    t.status === 'done' ? 'border-[var(--d-ok)] bg-[var(--d-ok)]' : 'border-[var(--d-line-strong)]'}`}>
                  {t.status === 'done' && <Check className="h-3.5 w-3.5 text-[var(--d-on-accent)]" strokeWidth={3} aria-hidden />}
                </button>
                <Link to={`/tasks/${t.id}`} className={`min-w-0 flex-1 truncate text-sm hover:underline ${t.status === 'done' ? 'dash-muted line-through' : ''}`}>
                  <span className="dash-muted mr-1 font-mono text-xs font-normal">#{t.num}</span>{t.title}
                </Link>
                <PriorityChip priority={t.priority} />
                <DueLabel task={t} />
                {t.assignee_id && <Avatar member={byUser(t.assignee_id)} size={20} />}
                {isAdmin && (
                  <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !px-2" aria-label={`Открепить «${t.title}»`}
                    onClick={() => confirm(`Открепить «${t.title}»? Она станет обычной, отдельной задачей.`) && detach.mutate(t.id)}>
                    <Link2Off className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </QueryState>

      <AddModal open={adding} onClose={() => setAdding(false)} task={task} onDone={refresh} />
      <AttachModal open={attaching} onClose={() => setAttaching(false)} task={task} onDone={refresh} />
    </section>
  )
}

function AddModal({ open, onClose, task, onDone }: { open: boolean; onClose: () => void; task: Task; onDone: () => void }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const create = useMutation({
    mutationFn: () => addSubtasks(task.id, text.split('\n')),
    onSuccess: created => { toast(`Добавлено подзадач: ${created.length}`); setText(''); onClose(); onDone() },
    onError: e => toast(errMsg(e), 'error'),
  })
  const submit = (e: FormEvent) => { e.preventDefault(); if (text.trim()) create.mutate() }
  return (
    <Modal open={open} onClose={onClose} title="Добавить подзадачи">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="dash-label mb-1.5 block">По одной на строку</span>
          <textarea className="dash-input min-h-40" autoFocus value={text} onChange={e => setText(e.target.value)}
            placeholder={'Проверить КСВ на 144 МГц\nПроверить экранирование корпуса\nЗамерить выходную мощность'} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
          <button className="dash-btn" disabled={create.isPending || !text.trim()}>{create.isPending ? 'Добавляем…' : 'Добавить'}</button>
        </div>
      </form>
    </Modal>
  )
}

function AttachModal({ open, onClose, task, onDone }: { open: boolean; onClose: () => void; task: Task; onDone: () => void }) {
  const { project } = useWorkspace()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const list = useQuery({
    queryKey: ['tasks', project.id, { sort: 'newest', topLevel: true }],
    queryFn: () => fetchTasks(project.id, { sort: 'newest', topLevel: true }),
    enabled: open,
  })
  const t = q.trim().toLowerCase()
  const candidates = (list.data ?? []).filter(x => x.id !== task.id && x.subtask_total === 0 && (!t || x.title.toLowerCase().includes(t)))

  const attach = useMutation({
    mutationFn: () => attachSubtasks(task.id, [...picked]),
    onSuccess: n => { toast(`Прикреплено: ${n}`); setPicked(new Set()); setQ(''); onClose(); onDone() },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <Modal open={open} onClose={onClose} title="Прикрепить существующие задачи">
      <div className="space-y-3">
        <p className="dash-muted text-sm">Задача станет частью чек-листа и исчезнет с доски как отдельная карточка.</p>
        <input className="dash-input" type="search" placeholder="Поиск по названию" aria-label="Поиск задач" autoFocus value={q} onChange={e => setQ(e.target.value)} />
        <ul className="max-h-72 overflow-y-auto rounded-xl border border-[var(--d-line)]">
          {candidates.map(x => (
            <li key={x.id}>
              <label className="dash-row flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                <input type="checkbox" className="accent-[var(--d-accent)]" checked={picked.has(x.id)}
                  onChange={() => setPicked(p => { const n = new Set(p); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n })} />
                <span className="min-w-0 flex-1 truncate"><span className="dash-muted mr-1 font-mono text-xs">#{x.num}</span>{x.title}</span>
              </label>
            </li>
          ))}
          {candidates.length === 0 && (
            <li className="dash-muted p-4 text-center text-sm">{list.isLoading ? 'Загрузка…' : 'Подходящих задач нет'}</li>
          )}
        </ul>
        <div className="flex justify-end gap-2">
          <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
          <button className="dash-btn" disabled={picked.size === 0 || attach.isPending} onClick={() => attach.mutate()}>
            {attach.isPending ? 'Прикрепляем…' : `Прикрепить (${picked.size})`}
          </button>
        </div>
      </div>
    </Modal>
  )
}

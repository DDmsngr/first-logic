import {
  createContext, useContext, useMemo, useRef, useState,
  type FormEvent, type MouseEvent, type PointerEvent, type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Check, MessageSquare, Paperclip } from 'lucide-react'
import { claimTask, createTask, releaseTask, updateTask, type TaskPatch } from './api'
import { useWorkspace } from './auth'
import { PRIORITIES, STATUSES, fmtDate, isOverdue, priorityMeta, statusMeta, todayIso } from './meta'
import type { Priority, Task, TaskStatus } from './types'
import { Avatar, DateInput, Field, Modal, errMsg, useToast } from './ui'

export function StatusChip({ status }: { status: TaskStatus }) {
  const m = statusMeta(status)
  return (
    <span className="dash-chip" style={{ color: m.color, borderColor: m.color + '66' }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} aria-hidden />{m.label}
    </span>
  )
}

export function PriorityChip({ priority }: { priority: Priority }) {
  const m = priorityMeta(priority)
  return <span className="dash-chip" style={{ color: m.color, borderColor: m.color + '66' }}>{m.label}</span>
}

export function DueLabel({ task }: { task: Pick<Task, 'due_date' | 'status'> }) {
  if (!task.due_date) return null
  const late = isOverdue(task.due_date, task.status)
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${late ? 'font-semibold text-[var(--d-danger)]' : 'dash-muted'}`}>
      <CalendarDays className="h-3.5 w-3.5" aria-hidden />
      {fmtDate(task.due_date)}{late && <span className="sr-only"> (просрочено)</span>}
    </span>
  )
}

export function LabelChips({ ids }: { ids: string[] }) {
  const { labels } = useWorkspace()
  return (
    <>
      {ids.map(id => labels.find(l => l.id === id)).filter(Boolean).map(l => (
        <span key={l!.id} className="dash-chip" style={{ color: l!.color, borderColor: l!.color + '66' }}>{l!.name}</span>
      ))}
    </>
  )
}

// ── множественный выбор задач ───────────────────────────────────────────────
//
// Ctrl/Cmd+клик (десктоп) и долгий тап → обычный тап (мобильный) переключают
// задачу в выборку вместо перехода на её страницу. Состояние живёт в контексте,
// который оборачивает страницу «Задачи» целиком — так выбор переживает
// переключение доска/список и пропадает при уходе со страницы (размонтирование).

interface TaskSelectionApi {
  selected: Set<string>
  /** режим выбора включён, пока в выборке есть хоть одна задача */
  mode: boolean
  enter: (id: string) => void
  toggle: (id: string) => void
  clear: () => void
}
const TaskSelectionCtx = createContext<TaskSelectionApi | null>(null)

export function TaskSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const api = useMemo<TaskSelectionApi>(() => ({
    selected,
    mode: selected.size > 0,
    enter: id => setSelected(new Set([id])),
    toggle: id => setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    }),
    clear: () => setSelected(new Set()),
  }), [selected])
  return <TaskSelectionCtx.Provider value={api}>{children}</TaskSelectionCtx.Provider>
}

export function useTaskSelectionCtx() {
  const v = useContext(TaskSelectionCtx)
  if (!v) throw new Error('useTaskSelectionCtx вне TaskSelectionProvider')
  return v
}

const LONG_PRESS_MS = 450
const LONG_PRESS_TOLERANCE_PX = 10

/**
 * Жест для одной задачи. Долгий тап пальцем входит в режим выбора; в остальных
 * случаях клик перехватывается на фазе capture — раньше, чем сработает переход
 * по ссылке или, на доске, чем dnd-kit начнёт перетаскивание.
 */
export function useTaskSelectGesture(taskId: string) {
  const { mode, selected, enter, toggle } = useTaskSelectionCtx()
  const press = useRef({ timer: 0, fired: false, x: 0, y: 0 })
  const clearTimer = () => { if (press.current.timer) { window.clearTimeout(press.current.timer); press.current.timer = 0 } }

  return {
    isSelected: selected.has(taskId),
    mode,
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        if (e.pointerType !== 'touch') return
        press.current.fired = false
        press.current.x = e.clientX; press.current.y = e.clientY
        press.current.timer = window.setTimeout(() => { press.current.fired = true; enter(taskId) }, LONG_PRESS_MS)
      },
      onPointerMove: (e: PointerEvent) => {
        if (!press.current.timer) return
        if (Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > LONG_PRESS_TOLERANCE_PX) clearTimer()
      },
      onPointerUp: clearTimer,
      onPointerCancel: clearTimer,
      onClickCapture: (e: MouseEvent) => {
        if (press.current.fired) { e.preventDefault(); e.stopPropagation(); press.current.fired = false; return }
        if (e.ctrlKey || e.metaKey || mode) { e.preventDefault(); e.stopPropagation(); toggle(taskId) }
      },
    },
  }
}

export function SelectMark({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden
      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-colors ${checked ? 'border-[var(--d-accent)] bg-[var(--d-accent)]' : 'border-[var(--d-line)]'}`}>
      {checked && <Check className="h-3.5 w-3.5 text-[var(--d-on-accent)]" strokeWidth={3} aria-hidden />}
    </span>
  )
}

/**
 * «Взять в работу» / «Отказаться»: свободную задачу забирает любой участник,
 * она закрепляется за ним. Внутри перетаскиваемой карточки события не должны
 * доходить до dnd-kit (иначе клик или Enter начнут drag).
 */
export function ClaimButton({ task, compact }: { task: Pick<Task, 'id' | 'assignee_id' | 'status'>; compact?: boolean }) {
  const { userId } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const mine = task.assignee_id === userId
  const free = !task.assignee_id && task.status !== 'done'
  const done = () => {
    for (const k of ['tasks', 'task', 'stats', 'activity', 'notifications']) qc.invalidateQueries({ queryKey: [k] })
  }
  const claim = useMutation({
    mutationFn: () => claimTask(task.id),
    onSuccess: () => { toast('Задача закреплена за вами'); done() },
    onError: e => { toast(errMsg(e), 'error'); done() },
  })
  const release = useMutation({
    mutationFn: () => releaseTask(task.id),
    onSuccess: () => { toast('Вы отказались от задачи, она снова свободна'); done() },
    onError: e => toast(errMsg(e), 'error'),
  })
  const stop = { onPointerDown: (e: React.SyntheticEvent) => e.stopPropagation(), onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation() }
  const size = compact ? 'dash-btn-sm !min-h-7 !px-2.5' : 'dash-btn-sm'

  if (free) {
    return <button type="button" className={`dash-btn ${size}`} disabled={claim.isPending} onClick={() => claim.mutate()} {...stop}>Взять</button>
  }
  if (mine && task.status !== 'done' && !compact) {
    return <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" disabled={release.isPending} onClick={() => release.mutate()} {...stop}>Отказаться от задачи</button>
  }
  return null
}

export function TaskCardBody({ task }: { task: Task }) {
  const { byUser } = useWorkspace()
  const free = !task.assignee_id && task.status !== 'done'
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <Link to={`/tasks/${task.id}`} draggable={false} className="min-w-0 flex-1 text-sm font-medium leading-snug hover:underline">
          <span className="dash-muted mr-1 font-mono text-xs font-normal">#{task.num}</span>{task.title}
        </Link>
        {!free && <Avatar member={byUser(task.assignee_id)} size={24} />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <PriorityChip priority={task.priority} />
        <LabelChips ids={task.label_ids} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {free && <span className="order-last ml-auto"><ClaimButton task={task} compact /></span>}
        <DueLabel task={task} />
        {task.comment_count > 0 && (
          <span className="dash-muted inline-flex items-center gap-1 text-xs" title="Комментарии">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />{task.comment_count}
            <span className="sr-only"> комментариев</span>
          </span>
        )}
        {task.attachment_count > 0 && (
          <span className="dash-muted inline-flex items-center gap-1 text-xs" title="Файлы">
            <Paperclip className="h-3.5 w-3.5" aria-hidden />{task.attachment_count}
            <span className="sr-only"> файлов</span>
          </span>
        )}
      </div>
    </>
  )
}

/** Правка задачи: сразу обновляет все закешированные списки, при отказе БД откатывает. */
export function useTaskUpdate() {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TaskPatch }) => updateTask(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ['tasks'] })
      const snapshot = qc.getQueriesData<Task[]>({ queryKey: ['tasks'] })
      qc.setQueriesData<Task[]>({ queryKey: ['tasks'] }, old => old?.map(t => (t.id === id ? { ...t, ...patch } : t)))
      qc.setQueryData<Task | null>(['task', id], old => (old ? { ...old, ...patch } : old))
      return { snapshot }
    },
    onError: (e, _v, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data))
      toast(errMsg(e), 'error')
    },
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['task', v.id] })
      qc.invalidateQueries({ queryKey: ['stats'] })
      qc.invalidateQueries({ queryKey: ['activity'] })
    },
  })
}

export function CreateTaskModal({ open, onClose, initialStatus = 'todo' }: {
  open: boolean; onClose: () => void; initialStatus?: TaskStatus
}) {
  const { workspace, project, members } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<TaskStatus>(initialStatus)
  const [priority, setPriority] = useState<Priority>('medium')
  const [assignee, setAssignee] = useState('')
  const [due, setDue] = useState('')

  const create = useMutation({
    mutationFn: () => createTask({
      workspace_id: workspace.id, project_id: project.id, title: title.trim(), description,
      status, priority, assignee_id: assignee || null, due_date: due || null,
    }),
    onSuccess: t => {
      toast(`Задача «${t.title}» создана`)
      setTitle(''); setDescription(''); setAssignee(''); setDue(''); setPriority('medium')
      for (const k of ['tasks', 'stats', 'activity', 'notifications']) qc.invalidateQueries({ queryKey: [k] })
      onClose()
    },
    onError: e => toast(errMsg(e), 'error'),
  })

  const submit = (e: FormEvent) => { e.preventDefault(); if (title.trim()) create.mutate() }
  const assignable = members.filter(m => m.status === 'active' && m.user_id)

  return (
    <Modal open={open} onClose={onClose} title="Новая задача">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Название">
          <input className="dash-input" required autoFocus value={title} onChange={e => setTitle(e.target.value)} />
        </Field>
        <Field label="Описание">
          <textarea className="dash-input" value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Статус">
            <select className="dash-input" value={status} onChange={e => setStatus(e.target.value as TaskStatus)}>
              {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Приоритет">
            <select className="dash-input" value={priority} onChange={e => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Исполнитель">
            <select className="dash-input" value={assignee} onChange={e => setAssignee(e.target.value)}>
              <option value="">Не назначен</option>
              {assignable.map(m => <option key={m.id} value={m.user_id!}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Срок">
            <DateInput min={todayIso()} value={due} onChange={setDue} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
          <button className="dash-btn" disabled={create.isPending || !title.trim()}>
            {create.isPending ? 'Создаём…' : 'Создать задачу'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

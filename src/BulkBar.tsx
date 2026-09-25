import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SlidersHorizontal, Trash2, X } from 'lucide-react'
import {
  bulkAddLabel, bulkArchiveTasks, bulkDeleteTasks, bulkRemoveLabel, bulkUpdateTasks,
  claimTask, releaseTask, type TaskPatch,
} from './api'
import { useWorkspace } from './auth'
import { PRIORITIES, STATUSES, pluralTasks, todayIso } from './meta'
import type { Priority, Task, TaskStatus } from './types'
import { DateInput, Field, Modal, errMsg, useToast } from './ui'
import { useTaskSelectionCtx } from './taskParts'

const REFRESH_KEYS = ['tasks', 'task', 'stats', 'activity', 'notifications', 'labels']

/**
 * Панель массовых действий. Что участнику доступно — те же правила, что и для
 * одной задачи: он видит только «Статус» (и только для своих задач в выборке) и
 * «Взять/Отказаться»; поле, назначение исполнителя, метки, срок, архив и удаление
 * — только owner/admin, ровно как в TaskDetail.
 */
export default function BulkBar({ tasks }: { tasks: Task[] }) {
  const { isAdmin, userId } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { selected, clear } = useTaskSelectionCtx()
  const [editOpen, setEditOpen] = useState(false)

  const ids = [...selected]
  // фильтрация по факту загруженных задач лечит случай, когда выбранная задача
  // пропала из выборки (например, её архивировали в другой вкладке)
  const selTasks = tasks.filter(t => ids.includes(t.id))

  const mine = selTasks.filter(t => t.assignee_id === userId)
  const free = selTasks.filter(t => !t.assignee_id && t.status !== 'done')
  const releasable = selTasks.filter(t => t.assignee_id === userId && t.status !== 'done')

  const refreshAll = () => REFRESH_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }))

  const quickStatus = useMutation({
    mutationFn: async (status: TaskStatus) => {
      const targetIds = (isAdmin ? selTasks : mine).map(t => t.id)
      if (!targetIds.length) throw new Error('Среди выбранных нет ваших задач')
      const applied = await bulkUpdateTasks(targetIds, { status })
      return { applied, skipped: selTasks.length - targetIds.length }
    },
    onSuccess: ({ applied, skipped }) => {
      toast(skipped > 0 ? `Статус изменён: ${applied}, пропущено (не ваши): ${skipped}` : `Статус изменён у ${pluralTasks(applied)}`)
      refreshAll(); clear()
    },
    onError: e => toast(errMsg(e), 'error'),
  })

  const claimAll = useMutation({
    mutationFn: async () => (await Promise.allSettled(free.map(t => claimTask(t.id)))).filter(r => r.status === 'fulfilled').length,
    onSuccess: n => { toast(`Взято: ${n} из ${free.length}`); refreshAll(); clear() },
  })

  const releaseAll = useMutation({
    mutationFn: async () => (await Promise.allSettled(releasable.map(t => releaseTask(t.id)))).filter(r => r.status === 'fulfilled').length,
    onSuccess: n => { toast(`Освобождено: ${n} из ${releasable.length}`); refreshAll(); clear() },
  })

  const archive = useMutation({
    mutationFn: () => bulkArchiveTasks(selTasks.map(t => t.id)),
    onSuccess: n => { toast(`Архивировано: ${pluralTasks(n)}`); refreshAll(); clear() },
    onError: e => toast(errMsg(e), 'error'),
  })

  const del = useMutation({
    mutationFn: () => bulkDeleteTasks(selTasks.map(t => t.id)),
    onSuccess: ({ deleted, filesFailed }) => {
      toast(filesFailed ? `Удалено: ${pluralTasks(deleted)}, часть файлов не удалилась` : `Удалено: ${pluralTasks(deleted)}`, filesFailed ? 'error' : 'ok')
      refreshAll(); clear()
    },
    onError: e => toast(errMsg(e), 'error'),
  })

  const busy = quickStatus.isPending || claimAll.isPending || releaseAll.isPending || archive.isPending || del.isPending

  // return ПОСЛЕ всех хуков: react error #310 (hooks mismatch), если условный
  // выход стоит раньше useMutation — при первом же выборе задачи компонент
  // внезапно вызывал на 5 хуков больше, чем на предыдущем рендере, и React
  // ронял всё дерево (клики по задачам переставали работать целиком).
  if (selTasks.length === 0) return null

  return (
    <div className="sticky top-16 z-20 mb-4 rounded-xl border border-[var(--d-accent)] bg-[var(--d-raised)] p-3 shadow-lg" role="toolbar" aria-label="Массовые действия">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold" aria-live="polite">Выбрано: {pluralTasks(selTasks.length)}</span>
        <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={clear}>
          <X className="h-3.5 w-3.5" aria-hidden /> Снять выделение
        </button>
      </div>

      <div className="mt-2.5 -mx-1 flex flex-nowrap gap-1.5 overflow-x-auto px-1 pb-1" aria-label="Переместить в статус">
        {STATUSES.map(s => (
          <button key={s.id} type="button" className="dash-chip shrink-0" disabled={busy}
            style={{ color: s.color, borderColor: s.color + '66' }} title={`Переместить в «${s.label}»`}
            onClick={() => quickStatus.mutate(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {free.length > 0 && (
          <button type="button" className="dash-btn dash-btn-sm" disabled={busy} onClick={() => claimAll.mutate()}>Взять ({free.length})</button>
        )}
        {releasable.length > 0 && (
          <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" disabled={busy} onClick={() => releaseAll.mutate()}>Отказаться ({releasable.length})</button>
        )}
        {isAdmin && (
          <>
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" disabled={busy} onClick={() => setEditOpen(true)}>
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden /> Действия…
            </button>
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" disabled={busy} onClick={() => archive.mutate()}>Архивировать</button>
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !text-[var(--d-danger)]" disabled={busy}
              onClick={() => { if (confirm(`Удалить ${pluralTasks(selTasks.length)}? Комментарии и файлы удалятся вместе с ними, это необратимо.`)) del.mutate() }}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Удалить
            </button>
          </>
        )}
      </div>

      {editOpen && (
        <BulkEditModal ids={selTasks.map(t => t.id)} count={selTasks.length}
          onClose={() => setEditOpen(false)} onDone={() => { refreshAll(); clear(); setEditOpen(false) }} />
      )}
    </div>
  )
}

function BulkEditModal({ ids, count, onClose, onDone }: {
  ids: string[]; count: number; onClose: () => void; onDone: () => void
}) {
  const { members, labels } = useWorkspace()
  const toast = useToast()
  const [status, setStatus] = useState('')
  const [priority, setPriority] = useState('')
  const [assignee, setAssignee] = useState('') // '', 'unassign' или user_id
  const [dueMode, setDueMode] = useState('') // '', 'set', 'clear'
  const [dueValue, setDueValue] = useState('')
  const [addLabel, setAddLabel] = useState('')
  const [removeLabel, setRemoveLabel] = useState('')

  const assignable = members.filter(m => m.status === 'active' && m.user_id)

  const apply = useMutation({
    mutationFn: async () => {
      const patch: TaskPatch = {}
      if (status) patch.status = status as TaskStatus
      if (priority) patch.priority = priority as Priority
      if (assignee === 'unassign') patch.assignee_id = null
      else if (assignee) patch.assignee_id = assignee
      if (dueMode === 'clear') patch.due_date = null
      else if (dueMode === 'set') {
        if (!dueValue) throw new Error('Укажите дату срока')
        patch.due_date = dueValue
      }
      if (!Object.keys(patch).length && !addLabel && !removeLabel) throw new Error('Ничего не выбрано для изменения')
      if (Object.keys(patch).length) await bulkUpdateTasks(ids, patch)
      if (addLabel) await bulkAddLabel(ids, addLabel)
      if (removeLabel) await bulkRemoveLabel(ids, removeLabel)
    },
    onSuccess: () => { toast(`Изменено: ${pluralTasks(ids.length)}`); onDone() },
    onError: e => toast(errMsg(e), 'error'),
  })

  const submit = (e: FormEvent) => { e.preventDefault(); apply.mutate() }

  return (
    <Modal open onClose={onClose} title={`Массовые действия · ${pluralTasks(count)}`}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Статус">
            <select className="dash-input" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">Не менять</option>
              {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Приоритет">
            <select className="dash-input" value={priority} onChange={e => setPriority(e.target.value)}>
              <option value="">Не менять</option>
              {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Исполнитель">
            <select className="dash-input" value={assignee} onChange={e => setAssignee(e.target.value)}>
              <option value="">Не менять</option>
              <option value="unassign">Сделать свободной</option>
              {assignable.map(m => <option key={m.id} value={m.user_id!}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Срок">
            <select className="dash-input" value={dueMode} onChange={e => setDueMode(e.target.value)}>
              <option value="">Не менять</option>
              <option value="set">Задать</option>
              <option value="clear">Снять</option>
            </select>
          </Field>
          {dueMode === 'set' && (
            <Field label="Новая дата">
              <DateInput min={todayIso()} value={dueValue} onChange={setDueValue} />
            </Field>
          )}
          <Field label="Добавить метку">
            <select className="dash-input" value={addLabel} onChange={e => setAddLabel(e.target.value)}>
              <option value="">Не менять</option>
              {labels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Убрать метку">
            <select className="dash-input" value={removeLabel} onChange={e => setRemoveLabel(e.target.value)}>
              <option value="">Не менять</option>
              {labels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
          <button className="dash-btn" disabled={apply.isPending}>{apply.isPending ? 'Применяем…' : 'Применить'}</button>
        </div>
      </form>
    </Modal>
  )
}

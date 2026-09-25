import { useProducts } from '../catalogParts'
import { useEffect, useMemo, useRef, useState, type PointerEventHandler } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, closestCorners,
  useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { LayoutGrid, List, Plus } from 'lucide-react'
import { fetchTasks } from '../api'
import { useWorkspace } from '../auth'
import { PRIORITIES, STATUSES } from '../meta'
import type { Priority, Task, TaskFilters, TaskStatus } from '../types'
import { Avatar, PageHeader, QueryState, useToast } from '../ui'
import TasksIO from '../TasksIO'
import BulkBar from '../BulkBar'
import {
  CreateTaskModal, DueLabel, PriorityChip, SelectMark, StatusChip, TaskCardBody,
  TaskSelectionProvider, useTaskSelectGesture, useTaskSelectionCtx, useTaskUpdate,
} from '../taskParts'

/** primary pointer грубый (палец) — на таких устройствах drag-and-drop отключаем в
 *  пользу выбора долгим тапом + массового переноса между колонками через BulkBar
 *  (см. обсуждение задачи: долгий тап конфликтует с таймером активации dnd-kit). */
const useIsCoarsePointer = () => useState(() => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches)[0]

/** Сбрасывает выборку, если реально изменились фильтры (переключение вида доска/список — не в счёт). */
function ClearSelectionOnFilterChange({ signal }: { signal: string }) {
  const { clear } = useTaskSelectionCtx()
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    clear()
  }, [signal]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

const SORTS: { id: TaskFilters['sort']; label: string }[] = [
  { id: 'priority', label: 'По приоритету' },
  { id: 'newest', label: 'Сначала новые' },
  { id: 'oldest', label: 'Сначала старые' },
  { id: 'due', label: 'По сроку' },
  { id: 'updated', label: 'Недавно обновлённые' },
]

function useFilters() {
  const [sp, setSp] = useSearchParams()
  const filters: TaskFilters = {
    status: sp.get('status') ? [sp.get('status') as TaskStatus] : undefined,
    priority: sp.get('priority') ? [sp.get('priority') as Priority] : undefined,
    assignee: sp.get('assignee') ?? undefined,
    label: sp.get('label') ?? undefined,
    product: sp.get('product') ?? undefined,
    due: (sp.get('due') as TaskFilters['due']) ?? undefined,
    q: sp.get('q') ?? undefined,
    sort: (sp.get('sort') as TaskFilters['sort']) ?? 'priority',
  }
  // setSp из React Router базируется на параметрах того рендера, где он создан.
  // Отложенный вызов (дебаунс поиска) иначе затрёр бы фильтр, выставленный за эти
  // 300 мс, — поэтому всегда берём setSp из последнего рендера через ref.
  const latest = useRef(setSp)
  latest.current = setSp
  const set = (k: string, v: string) => latest.current(prev => {
    const next = new URLSearchParams(prev)
    if (v) next.set(k, v); else next.delete(k)
    return next
  }, { replace: true })
  const clear = () => latest.current(prev => new URLSearchParams(prev.get('view') ? { view: prev.get('view')! } : {}), { replace: true })
  const active = ['status', 'priority', 'assignee', 'label', 'product', 'due', 'q'].some(k => sp.get(k))
  return { filters, set, clear, active, view: sp.get('view') === 'list' ? 'list' : 'board' } as const
}

export default function Tasks() {
  const { project, members, labels, isAdmin } = useWorkspace()
  const { filters, set, clear, active, view } = useFilters()
  const [createStatus, setCreateStatus] = useState<TaskStatus | null>(null)

  // дебаунс поля поиска: в URL (а значит и в запрос) попадает после паузы
  const [qDraft, setQDraft] = useState(filters.q ?? '')
  useEffect(() => {
    const t = setTimeout(() => { if ((filters.q ?? '') !== qDraft) set('q', qDraft) }, 300)
    return () => clearTimeout(t)
  }, [qDraft]) // eslint-disable-line react-hooks/exhaustive-deps

  const tasks = useQuery({
    queryKey: ['tasks', project.id, filters],
    queryFn: () => fetchTasks(project.id, filters),
    placeholderData: prev => prev,
  })

  const active_ = members.filter(m => m.status === 'active' && m.user_id)
  const products = useProducts()
  const isTouch = useIsCoarsePointer()

  return (
    <TaskSelectionProvider>
      <ClearSelectionOnFilterChange signal={JSON.stringify(filters)} />
      <PageHeader
        title="Задачи"
        sub={tasks.data ? `${tasks.data.length} в выборке` : undefined}
        actions={
          <>
            <div className="flex overflow-hidden rounded-lg border border-[var(--d-line)]" role="group" aria-label="Вид">
              <button className={`dash-btn dash-btn-sm !rounded-none ${view === 'board' ? '' : 'dash-btn-ghost'}`} aria-pressed={view === 'board'} onClick={() => set('view', '')}>
                <LayoutGrid className="h-4 w-4" aria-hidden /> Доска
              </button>
              <button className={`dash-btn dash-btn-sm !rounded-none ${view === 'list' ? '' : 'dash-btn-ghost'}`} aria-pressed={view === 'list'} onClick={() => set('view', 'list')}>
                <List className="h-4 w-4" aria-hidden /> Список
              </button>
            </div>
            <TasksIO exportTasks={tasks.data ?? []} />
            {isAdmin && (
              <button className="dash-btn" onClick={() => setCreateStatus('todo')}>
                <Plus className="h-4 w-4" aria-hidden /> Новая задача
              </button>
            )}
          </>
        }
      />

      <form role="search" aria-label="Фильтры задач" className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-5" onSubmit={e => e.preventDefault()}>
        <input className="dash-input col-span-2" type="search" placeholder="Поиск по задачам" aria-label="Поиск по задачам" value={qDraft} onChange={e => setQDraft(e.target.value)} />
        <select className="dash-input" aria-label="Статус" value={filters.status?.[0] ?? ''} onChange={e => set('status', e.target.value)}>
          <option value="">Все статусы</option>
          {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <select className="dash-input" aria-label="Приоритет" value={filters.priority?.[0] ?? ''} onChange={e => set('priority', e.target.value)}>
          <option value="">Любой приоритет</option>
          {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <select className="dash-input" aria-label="Исполнитель" value={filters.assignee ?? ''} onChange={e => set('assignee', e.target.value)}>
          <option value="">Все исполнители</option>
          <option value="none">Не назначено</option>
          {active_.map(m => <option key={m.id} value={m.user_id!}>{m.name}</option>)}
        </select>
        <select className="dash-input" aria-label="Метка" value={filters.label ?? ''} onChange={e => set('label', e.target.value)}>
          <option value="">Все метки</option>
          {labels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select className="dash-input" aria-label="Изделие" value={filters.product ?? ''} onChange={e => set('product', e.target.value)}>
          <option value="">Все изделия</option>
          <option value="none">Без изделия</option>
          {products.data?.map(p => <option key={p.id} value={p.id}>{p.name}{p.version ? ` ${p.version}` : ''}</option>)}
        </select>
        <select className="dash-input" aria-label="Срок" value={filters.due ?? ''} onChange={e => set('due', e.target.value)}>
          <option value="">Любой срок</option>
          <option value="overdue">Просроченные</option>
          <option value="week">На этой неделе</option>
          <option value="none">Без срока</option>
        </select>
        <select className="dash-input" aria-label="Сортировка" value={filters.sort} onChange={e => set('sort', e.target.value)}>
          {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        {active && <button type="button" className="dash-btn dash-btn-ghost" onClick={() => { clear(); setQDraft('') }}>Сбросить</button>}
      </form>

      <p className="dash-muted -mt-2 mb-4 text-xs">
        {isTouch ? 'Долгий тап по задаче — выбор нескольких, затем обычный тап добавляет ещё.' : 'Выбор нескольких задач: Ctrl (⌘ на Mac) + клик по карточке, дальше добавляйте обычным кликом. Появится панель массовых действий.'}
      </p>

      <BulkBar tasks={tasks.data ?? []} />

      <QueryState loading={tasks.isLoading} error={tasks.error} onRetry={() => tasks.refetch()}
        empty={!!tasks.data && tasks.data.length === 0 && view === 'list'}
        emptyText={active ? 'Под фильтры ничего не подходит' : 'Задач пока нет'}
        emptyHint={!active && isAdmin ? 'Создайте первую кнопкой «Новая задача».' : undefined}>
        {view === 'board'
          ? <Board tasks={tasks.data ?? []} onCreate={isAdmin ? setCreateStatus : undefined} isTouch={isTouch} />
          : <ListView tasks={tasks.data ?? []} />}
      </QueryState>

      {createStatus && <CreateTaskModal key={createStatus} open onClose={() => setCreateStatus(null)} initialStatus={createStatus} />}
    </TaskSelectionProvider>
  )
}

// ── доска ───────────────────────────────────────────────────────────────────

function Board({ tasks, onCreate, isTouch }: { tasks: Task[]; onCreate?: (s: TaskStatus) => void; isTouch: boolean }) {
  const { isAdmin, userId } = useWorkspace()
  const update = useTaskUpdate()
  const toast = useToast()
  const [dragging, setDragging] = useState<Task | null>(null)

  // dnd-kit нужны одни и те же хуки на каждом рендере — переключаем только состав массива
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } })
  const keyboardSensor = useSensor(KeyboardSensor)
  const sensors = useSensors(...(isTouch ? [keyboardSensor] : [pointerSensor, touchSensor, keyboardSensor]))

  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>(STATUSES.map(s => [s.id, []]))
    tasks.forEach(t => m.get(t.status)?.push(t))
    m.forEach(list => list.sort((a, b) => a.position - b.position))
    return m
  }, [tasks])

  // на тачскрине drag выключен целиком — конфликтует с долгим тапом (см. useIsCoarsePointer)
  const canMove = (t: Task) => !isTouch && (isAdmin || t.assignee_id === userId)

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    const task = tasks.find(t => t.id === e.active.id)
    const over = e.over
    if (!task || !over || over.id === task.id) return
    const overTask = tasks.find(t => t.id === over.id)
    const target = (overTask?.status ?? over.id) as TaskStatus
    if (!STATUSES.some(s => s.id === target)) return
    if (!canMove(task)) { toast('Двигать можно только свои задачи', 'error'); return }

    const col = (byStatus.get(target) ?? []).filter(t => t.id !== task.id)
    let position: number
    if (overTask) {
      const i = col.findIndex(t => t.id === overTask.id)
      const prev = col[i - 1]?.position
      position = prev === undefined ? overTask.position - 1000 : (prev + overTask.position) / 2
    } else {
      position = (col[col.length - 1]?.position ?? 0) + 1000
    }
    if (target === task.status && !overTask) return
    update.mutate({ id: task.id, patch: { status: target, position } })
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners}
      onDragStart={(e: DragStartEvent) => setDragging(tasks.find(t => t.id === e.active.id) ?? null)}
      onDragCancel={() => setDragging(null)} onDragEnd={onDragEnd}>
      <div className="relative -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 md:mx-0 md:px-0" data-testid="board">
        {STATUSES.map(s => (
          <Column key={s.id} status={s.id} tasks={byStatus.get(s.id) ?? []} canMove={canMove} onCreate={onCreate} />
        ))}
      </div>
      <DragOverlay>
        {dragging && <div className="dash-card w-64 rotate-2 p-3 shadow-2xl"><TaskCardBody task={dragging} /></div>}
      </DragOverlay>
    </DndContext>
  )
}

function Column({ status, tasks, canMove, onCreate }: {
  status: TaskStatus; tasks: Task[]; canMove: (t: Task) => boolean; onCreate?: (s: TaskStatus) => void
}) {
  const meta = STATUSES.find(s => s.id === status)!
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <section ref={setNodeRef} aria-label={meta.label} data-testid={`col-${status}`}
      className={`flex w-[78vw] max-w-72 shrink-0 snap-center flex-col rounded-2xl border bg-[var(--d-surface)] p-2.5 md:w-64 md:max-w-none xl:flex-1 xl:min-w-52 ${isOver ? 'border-[var(--d-accent)]' : 'border-[var(--d-line)]'}`}>
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider">
          <Link to={`/tasks?status=${status}&view=list`} className="flex items-center gap-2 hover:underline"
            title={`Показать только «${meta.label}» списком`}>
            <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} aria-hidden />
            {meta.label} <span className="dash-muted font-normal" data-testid="count">{tasks.length}</span>
          </Link>
        </h2>
        {onCreate && (
          <button className="dash-btn dash-btn-ghost dash-btn-sm !min-h-7 !px-2" onClick={() => onCreate(status)} aria-label={`Добавить задачу в ${meta.label}`}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      <ul className="flex min-h-16 flex-1 flex-col gap-2">
        {tasks.map(t => <Card key={t.id} task={t} movable={canMove(t)} />)}
        {tasks.length === 0 && <li className="dash-muted grid flex-1 place-items-center rounded-lg border border-dashed border-[var(--d-line)] p-3 text-xs">Пусто</li>}
      </ul>
    </section>
  )
}

function Card({ task, movable }: { task: Task; movable: boolean }) {
  const drag = useDraggable({ id: task.id, disabled: !movable })
  const drop = useDroppable({ id: task.id })
  const select = useTaskSelectGesture(task.id)
  // dnd-kit вешает role="button" aria-disabled="true" на карточку, даже когда
  // перетаскивание выключено (disabled: true), — а aria-disabled на предке блокирует
  // клики по вложенным ссылкам/кнопкам (проверяется и Playwright, и реальными
  // скринридерами). Поэтому атрибуты и обработчики drag добавляем, только когда
  // карточку действительно можно тащить, а onPointerDown сводим явно — оба
  // обработчика используют один и тот же проп, порядок спреда тут ненадёжен.
  const dragListeners = movable ? drag.listeners : undefined
  const onPointerDown: PointerEventHandler<HTMLLIElement> = e => {
    select.handlers.onPointerDown(e)
    dragListeners?.onPointerDown?.(e)
  }
  return (
    <li ref={n => { drag.setNodeRef(n); drop.setNodeRef(n) }} data-testid={`card-${task.id}`}
      {...select.handlers} {...(movable ? drag.attributes : {})} {...dragListeners} onPointerDown={onPointerDown}
      aria-roledescription={movable ? 'перетаскиваемая задача' : undefined}
      aria-selected={select.mode ? select.isSelected : undefined}
      className={`dash-card touch-manipulation bg-[var(--d-raised)] p-3 ${movable ? 'cursor-grab' : ''} ${drag.isDragging ? 'opacity-30' : ''} ${select.isSelected ? 'ring-2 ring-[var(--d-accent)]' : ''}`}>
      {select.mode ? (
        <div className="flex items-start gap-2">
          <SelectMark checked={select.isSelected} />
          <div className="min-w-0 flex-1"><TaskCardBody task={task} /></div>
        </div>
      ) : <TaskCardBody task={task} />}
    </li>
  )
}

// ── список ──────────────────────────────────────────────────────────────────

function ListView({ tasks }: { tasks: Task[] }) {
  const { byUser } = useWorkspace()
  const [shown, setShown] = useState(25)
  return (
    <div className="dash-card overflow-hidden">
      <ul>
        {tasks.slice(0, shown).map(t => <ListRow key={t.id} task={t} byUser={byUser} />)}
      </ul>
      {shown < tasks.length && (
        <div className="p-3 text-center"><button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setShown(s => s + 25)}>Показать ещё ({tasks.length - shown})</button></div>
      )}
    </div>
  )
}

function ListRow({ task: t, byUser }: { task: Task; byUser: ReturnType<typeof useWorkspace>['byUser'] }) {
  const select = useTaskSelectGesture(t.id)
  return (
    <li data-testid={`row-${t.id}`} {...select.handlers}
      aria-selected={select.mode ? select.isSelected : undefined}
      className={`dash-row flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 ${select.isSelected ? 'bg-[var(--d-raised)]' : ''}`}>
      {select.mode && <SelectMark checked={select.isSelected} />}
      <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1 basis-56 truncate text-sm font-medium hover:underline"><span className="dash-muted mr-1 font-mono text-xs font-normal">#{t.num}</span>{t.title}</Link>
      <StatusChip status={t.status} />
      <PriorityChip priority={t.priority} />
      <DueLabel task={t} />
      <span className="flex items-center gap-2 text-xs dash-muted"><Avatar member={byUser(t.assignee_id)} size={22} />{byUser(t.assignee_id)?.name ?? 'Не назначено'}</span>
    </li>
  )
}

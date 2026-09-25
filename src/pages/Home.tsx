import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchStats, fetchTasks } from '../api'
import { useWorkspace } from '../auth'
import { fmtDate, plusDaysIso, timeAgo, todayIso } from '../meta'
import { supabase } from '../supabase'
import type { Message, Task } from '../types'
import { Avatar, PageHeader, QueryState } from '../ui'
import { ActivityList } from '../shared'
import { ClaimButton, DueLabel, PriorityChip, StatusChip } from '../taskParts'
import { fetchComponents, needsReorder } from '../catalog'
import { Stock, useRates } from '../catalogParts'
import { fmtMoney, toRub } from '../money'

const TILES: { key: string; label: string; to: string; color: string }[] = [
  { key: 'total', label: 'Всего', to: '/tasks', color: 'var(--d-text)' },
  { key: 'todo', label: 'To Do', to: '/tasks?status=todo', color: '#a3b0bd' },
  { key: 'in_progress', label: 'In Progress', to: '/tasks?status=in_progress', color: 'var(--d-accent)' },
  { key: 'review', label: 'Review', to: '/tasks?status=review', color: '#b49cf0' },
  { key: 'done', label: 'Done', to: '/tasks?status=done', color: 'var(--d-ok)' },
  { key: 'blocked', label: 'Blocked', to: '/tasks?status=blocked', color: 'var(--d-danger)' },
  { key: 'overdue', label: 'Просрочено', to: '/tasks?due=overdue', color: 'var(--d-danger)' },
]

// min-w-0: как прямой ребёнок grid-контейнера, section по умолчанию не может
// сжаться уже своего минимального содержимого (min-width:auto у грид-айтемов) —
// нераскрывающийся чип внутри тогда раздувает колонку шире экрана, и flex-wrap
// в строках ниже уже не успевает отработать, хотя формально «настроен»
const Panel = ({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) => (
  <section className="dash-card min-w-0 p-4" aria-label={title}>
    <div className="mb-3 flex items-center justify-between"><h2 className="dash-label">{title}</h2>{action}</div>
    {children}
  </section>
)

export default function Home() {
  const { project, workspace, userId, byUser, members, me } = useWorkspace()
  const stats = useQuery({ queryKey: ['stats', project.id], queryFn: () => fetchStats(project.id) })
  const tasks = useQuery({ queryKey: ['tasks', project.id, { sort: 'priority' }], queryFn: () => fetchTasks(project.id, { sort: 'priority' }) })
  const recentMsgs = useQuery({
    queryKey: ['messages', 'recent', workspace.id],
    queryFn: async () => {
      const r = await supabase.from('ws_messages').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(5)
      if (r.error) throw new Error(r.error.message)
      return r.data as Message[]
    },
  })

  const all = tasks.data ?? []
  const mine = all.filter(t => t.assignee_id === userId && t.status !== 'done')
  const soon = all.filter(t => t.due_date && t.status !== 'done' && t.due_date >= todayIso() && t.due_date <= plusDaysIso(7))
    .sort((a, b) => a.due_date!.localeCompare(b.due_date!))
  const free = all.filter(t => !t.assignee_id && t.status !== 'done')
  const blocked = all.filter(t => t.status === 'blocked')
  const overdue = all.filter(t => t.due_date && t.status !== 'done' && t.due_date < todayIso())
  const people = members.filter(m => m.status === 'active' && m.user_id)

  return (
    <>
      <PageHeader title={`Привет, ${me.name.split(' ')[0]}`} sub={`${workspace.name} · ${project.name}`} />

      <QueryState loading={stats.isLoading} error={stats.error} onRetry={() => stats.refetch()}>
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7" data-testid="stats">
          {TILES.map(t => (
            <Link key={t.key} to={t.to} className="dash-card p-4 transition-colors hover:bg-[var(--d-raised)]" data-testid={`stat-${t.key}`}>
              <div className="text-2xl font-semibold tabular-nums" style={{ color: (stats.data?.[t.key] ?? 0) > 0 || t.key === 'total' ? t.color : undefined }}>{stats.data?.[t.key] ?? 0}</div>
              <div className="dash-muted mt-0.5 text-xs">{t.label}</div>
            </Link>
          ))}
        </div>
      </QueryState>

      <Inventory />

      {(blocked.length > 0 || overdue.length > 0) && (
        <div className="mb-5 grid gap-3 md:grid-cols-2">
          {blocked.length > 0 && <TaskListPanel title="Заблокировано" tasks={blocked} accent />}
          {overdue.length > 0 && <TaskListPanel title="Просрочено" tasks={overdue} accent />}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 lg:col-span-2">
          <Panel title={`Свободные задачи · ${free.length}`} action={<Link to="/tasks?assignee=none" className="dash-muted text-xs underline">Все свободные</Link>}>
            <QueryState loading={tasks.isLoading} error={tasks.error} onRetry={() => tasks.refetch()} empty={free.length === 0} emptyText="Свободных задач нет" emptyHint="Задачи без исполнителя может взять любой участник — они появятся здесь.">
              <ul data-testid="free-tasks">
                {free.slice(0, 6).map(t => (
                  <li key={t.id} className="dash-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1 basis-44 truncate text-sm font-medium hover:underline"><span className="dash-muted mr-1 font-mono text-xs font-normal">#{t.num}</span>{t.title}</Link>
                    <PriorityChip priority={t.priority} />
                    {t.due_date && <DueLabel task={t} />}
                    <ClaimButton task={t} compact />
                  </li>
                ))}
              </ul>
            </QueryState>
          </Panel>
        </div>

        <Panel title="Мои задачи">
          <QueryState loading={tasks.isLoading} error={tasks.error} onRetry={() => tasks.refetch()} empty={mine.length === 0} emptyText="На вас ничего не назначено">
            <TaskRows tasks={mine.slice(0, 6)} />
          </QueryState>
        </Panel>

        <Panel title="Ближайшие сроки (7 дней)">
          <QueryState loading={tasks.isLoading} error={tasks.error} onRetry={() => tasks.refetch()} empty={soon.length === 0} emptyText="Срочного нет">
            <TaskRows tasks={soon.slice(0, 6)} />
          </QueryState>
        </Panel>

        <Panel title="Кто чем занят">
          <QueryState loading={tasks.isLoading} error={tasks.error} onRetry={() => tasks.refetch()} empty={people.length === 0} emptyText="Нет активных участников">
            <ul>
              {people.map(m => {
                const active = all.filter(t => t.assignee_id === m.user_id && t.status === 'in_progress')
                const queued = all.filter(t => t.assignee_id === m.user_id && ['todo', 'review'].includes(t.status)).length
                return (
                  <li key={m.id} className="dash-row flex items-start gap-3 py-2.5">
                    <Avatar member={m} size={30} />
                    <div className="min-w-0 flex-1">
                      <Link to={`/team/${m.user_id}`} className="text-sm font-medium hover:underline">{m.name}</Link>
                      <div className="dash-muted text-xs">
                        {active.length ? active.map(t => t.title).join(' · ') : 'Сейчас ничего в работе'}
                        {queued > 0 && ` · в очереди ${queued}`}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </QueryState>
        </Panel>

        <Panel title="Последние сообщения" action={<Link to="/messages" className="dash-muted text-xs underline">Все</Link>}>
          <QueryState loading={recentMsgs.isLoading} error={recentMsgs.error} onRetry={() => recentMsgs.refetch()} empty={recentMsgs.data?.length === 0} emptyText="Сообщений пока нет">
            <ul>
              {recentMsgs.data?.map(m => (
                <li key={m.id} className="dash-row py-2">
                  <Link to={`/messages/${m.conversation_id}`} className="block text-sm hover:underline">
                    <b>{byUser(m.author_id)?.name ?? 'Участник'}</b>: <span className="dash-muted">{m.body.slice(0, 90)}</span>
                  </Link>
                  <span className="dash-muted text-xs">{timeAgo(m.created_at)}</span>
                </li>
              ))}
            </ul>
          </QueryState>
        </Panel>

        <div className="min-w-0 lg:col-span-2"><Panel title="Последняя активность"><ActivityList /></Panel></div>
      </div>
    </>
  )
}

function TaskRows({ tasks }: { tasks: Task[] }) {
  return (
    <ul>
      {tasks.map(t => (
        <li key={t.id} className="dash-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
          <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1 basis-44 truncate text-sm font-medium hover:underline">{t.title}</Link>
          <StatusChip status={t.status} /><PriorityChip priority={t.priority} />
          {t.due_date ? <DueLabel task={t} /> : <span className="dash-muted text-xs">{fmtDate(null)}</span>}
        </li>
      ))}
    </ul>
  )
}

function TaskListPanel({ title, tasks, accent }: { title: string; tasks: Task[]; accent?: boolean }) {
  return (
    <section className={`dash-card min-w-0 p-4 ${accent ? '!border-[var(--d-danger-line)]' : ''}`} aria-label={title}>
      <h2 className="dash-label mb-2 !text-[var(--d-danger)]">{title} · {tasks.length}</h2>
      <TaskRows tasks={tasks.slice(0, 4)} />
    </section>
  )
}

/** Склад: сколько позиций, на какую сумму, что пора заказать. */
function Inventory() {
  const { workspace } = useWorkspace()
  const comps = useQuery({ queryKey: ['components', workspace.id, { archived: false }], queryFn: () => fetchComponents(workspace.id) })
  const rates = useRates()
  const all = comps.data ?? []
  const low = all.filter(needsReorder)
  const value = all.reduce((s, c) => s + Math.max(c.stock, 0) * (toRub(c.price, c.currency, rates.data ?? []) ?? 0), 0)
  if (comps.isLoading || comps.error) return null
  return (
    <div className="mb-5 grid gap-3 md:grid-cols-[repeat(3,minmax(0,1fr))_2fr]">
      <Link to="/components" className="dash-card p-4 transition-colors hover:bg-[var(--d-raised)]">
        <div className="text-2xl font-semibold tabular-nums">{all.length}</div>
        <div className="dash-muted mt-0.5 text-xs">Компонентов</div>
      </Link>
      <Link to="/components?reorder=1" className="dash-card p-4 transition-colors hover:bg-[var(--d-raised)]">
        <div className="text-2xl font-semibold tabular-nums" style={{ color: low.length ? 'var(--d-warn)' : undefined }}>{low.length}</div>
        <div className="dash-muted mt-0.5 text-xs">Заказать</div>
      </Link>
      <Link to="/components?sort=price" className="dash-card p-4 transition-colors hover:bg-[var(--d-raised)]">
        <div className="text-2xl font-semibold tabular-nums">{fmtMoney(value, 'RUB')}</div>
        <div className="dash-muted mt-0.5 text-xs">На складе</div>
      </Link>
      <section className="dash-card min-w-0 p-4" aria-label="Пора заказать">
        <h2 className="dash-label mb-2">Пора заказать · {low.length}</h2>
        {low.length === 0
          ? <p className="dash-muted text-sm">Все остатки выше минимума</p>
          : <ul>{low.slice(0, 4).map(c => (
              <li key={c.id} className="dash-row flex items-center gap-3 py-1.5 text-sm">
                <Link to={`/components/${c.id}`} className="min-w-0 flex-1 truncate hover:underline">{c.name}</Link>
                <Stock c={c} />
              </li>))}</ul>}
      </section>
    </div>
  )
}

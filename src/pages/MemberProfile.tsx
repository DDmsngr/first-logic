import { presenceLabel } from '../presence'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import { fetchTasks, openDirect } from '../api'
import { useWorkspace } from '../auth'
import { MEMBER_STATUS_LABEL, ROLE_LABEL, fmtDate } from '../meta'
import { Avatar, QueryState, errMsg, useToast } from '../ui'
import { ActivityList } from '../shared'
import { DueLabel, PriorityChip, StatusChip } from '../taskParts'

export default function MemberProfile() {
  const { userId = '' } = useParams()
  const { members, project, workspace, userId: myId } = useWorkspace()
  const nav = useNavigate()
  const toast = useToast()
  const m = members.find(x => x.user_id === userId)
  const tasks = useQuery({
    queryKey: ['tasks', project.id, { sort: 'updated', assignee: userId }],
    queryFn: () => fetchTasks(project.id, { sort: 'updated', assignee: userId }),
    enabled: !!m,
  })
  const dm = useMutation({
    mutationFn: () => openDirect(workspace.id, userId),
    onSuccess: id => nav(`/messages/${id}`),
    onError: e => toast(errMsg(e), 'error'),
  })

  if (!m) {
    return <QueryState loading={false} error={null} empty emptyText="Участник не найден" onRetry={() => {}}><></></QueryState>
  }
  const all = tasks.data ?? []
  const active = all.filter(t => t.status !== 'done')
  const done = all.filter(t => t.status === 'done')

  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/team" className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> Команда</Link>
      <header className="dash-card mb-5 flex flex-wrap items-center gap-4 p-5">
        <Avatar member={m} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{m.name}</h1>
          {m.position && <p className="text-sm">{m.position}</p>}
          <p className="dash-muted text-sm">{m.email}{m.phone ? ` · ${m.phone}` : ''}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="dash-chip">{ROLE_LABEL[m.role]}</span>
            <span className="dash-chip">{MEMBER_STATUS_LABEL[m.status]}</span>
            <span className="dash-chip">в команде с {fmtDate(m.joined_at)}</span>
            <span className="dash-chip">активность: {presenceLabel(m)}{userId === myId && ' (так видят вас)'}</span>
          </div>
        </div>
        {userId !== myId && <button className="dash-btn" disabled={dm.isPending} onClick={() => dm.mutate()}><MessageSquare className="h-4 w-4" aria-hidden /> Написать</button>}
      </header>

      <QueryState loading={tasks.isLoading} error={tasks.error} onRetry={() => tasks.refetch()}>
        <div className="grid gap-4 md:grid-cols-2">
          {[{ t: 'Активные задачи', list: active, e: 'Активных задач нет' }, { t: 'Завершённые', list: done, e: 'Завершённых пока нет' }].map(g => (
            <section key={g.t} className="dash-card min-w-0 p-4" aria-label={g.t}>
              <h2 className="dash-label mb-2">{g.t} · {g.list.length}</h2>
              {g.list.length === 0 ? <p className="dash-muted text-sm">{g.e}</p> : (
                <ul>{g.list.map(t => (
                  <li key={t.id} className="dash-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1 basis-40 truncate text-sm font-medium hover:underline">{t.title}</Link>
                    <StatusChip status={t.status} /><PriorityChip priority={t.priority} /><DueLabel task={t} />
                  </li>
                ))}</ul>
              )}
            </section>
          ))}
        </div>
      </QueryState>

      <section className="dash-card mt-4 p-4" aria-label="Активность"><h2 className="dash-label mb-3">Последняя активность</h2><ActivityList actorId={userId} empty="Действий пока нет" /></section>
    </div>
  )
}

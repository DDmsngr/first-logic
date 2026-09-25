import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchNotifications, markNotifications } from '../api'
import { useWorkspace } from '../auth'
import { timeAgo } from '../meta'
import type { Notification } from '../types'
import { PageHeader, QueryState, errMsg, useToast } from '../ui'

/** Личные — адресованы лично вам; остальное — события по командным задачам. */
const PERSONAL = ['assigned', 'mention', 'overdue']

const TABS = [
  { id: 'personal', label: 'Личные', empty: 'Личных уведомлений нет', hint: 'Сюда приходит: вам назначили задачу, вас упомянули, ваша задача просрочена.' },
  { id: 'team', label: 'Общие', empty: 'Общих уведомлений нет', hint: 'Сюда приходит: статусы и блокировки, комментарии и файлы в задачах, за которыми вы следите, новые участники.' },
] as const

export default function Notifications() {
  const { workspace } = useWorkspace()
  const qc = useQueryClient()
  const nav = useNavigate()
  const toast = useToast()
  const [sp, setSp] = useSearchParams()
  const tab = sp.get('tab') === 'team' ? 'team' : 'personal'

  const list = useQuery({ queryKey: ['notifications', workspace.id], queryFn: () => fetchNotifications(workspace.id) })
  const mark = useMutation({
    mutationFn: markNotifications,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
    onError: e => toast(errMsg(e), 'error'),
  })

  const all = list.data ?? []
  const isPersonal = (n: Notification) => PERSONAL.includes(n.kind)
  const inTab = (id: string) => all.filter(n => (id === 'personal') === isPersonal(n))
  const shown = inTab(tab)
  const unreadIn = (id: string) => inTab(id).filter(n => !n.read_at)
  const unread = unreadIn(tab)

  const open = (n: Notification) => {
    if (!n.read_at) mark.mutate([n.id])
    nav(n.link)
  }

  return (
    <>
      <PageHeader title="Уведомления" sub={unread.length ? `${unread.length} непрочитанных в этой вкладке` : 'Всё прочитано'}
        actions={unread.length > 0 && <button className="dash-btn dash-btn-ghost" onClick={() => mark.mutate(unread.map(n => n.id))}>Прочитать все</button>} />

      <div role="tablist" aria-label="Тип уведомлений" className="mb-4 flex gap-2">
        {TABS.map(t => {
          const n = unreadIn(t.id).length
          return (
            <button key={t.id} role="tab" aria-selected={tab === t.id} id={`tab-${t.id}`} aria-controls="notif-panel"
              className={`dash-btn dash-btn-sm ${tab === t.id ? 'dash-tab-active' : 'dash-btn-ghost'}`}
              onClick={() => setSp(t.id === 'personal' ? {} : { tab: t.id }, { replace: true })}>
              {t.label}
              {n > 0 && <span className={`rounded-full px-1.5 text-[11px] font-bold ${tab === t.id ? 'bg-black/20' : 'bg-[var(--d-tint)] text-[var(--d-on-accent)]'}`}
                aria-label={`${n} непрочитанных`}>{n}</span>}
            </button>
          )
        })}
      </div>

      <div className="dash-card" role="tabpanel" id="notif-panel" aria-labelledby={`tab-${tab}`}>
        <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()}
          empty={shown.length === 0} emptyText={TABS.find(t => t.id === tab)!.empty} emptyHint={TABS.find(t => t.id === tab)!.hint}>
          <ul data-testid="notifications">
            {shown.map(n => (
              <li key={n.id} className="dash-row">
                <button className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-[var(--d-raised)]" onClick={() => open(n)}>
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? 'bg-transparent' : 'bg-[var(--d-tint)]'}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm ${n.read_at ? 'dash-muted' : 'font-medium'}`}>{n.title}{!n.read_at && <span className="sr-only"> (не прочитано)</span>}</span>
                    <span className="dash-muted text-xs">{timeAgo(n.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </QueryState>
      </div>
    </>
  )
}

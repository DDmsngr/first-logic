import type { DocType, ActivityEvent, Member, MemberStatus, Priority, Role, TaskStatus } from './types'

export const STATUSES: { id: TaskStatus; label: string; color: string }[] = [
  { id: 'backlog', label: 'Backlog', color: '#6b7785' },
  { id: 'todo', label: 'To Do', color: '#a3b0bd' },
  { id: 'in_progress', label: 'In Progress', color: '#5ec4e6' },
  { id: 'review', label: 'Review', color: '#b49cf0' },
  { id: 'blocked', label: 'Blocked', color: '#f06a6a' },
  { id: 'done', label: 'Done', color: '#5fd08f' },
]

export const PRIORITIES: { id: Priority; label: string; color: string; weight: number }[] = [
  { id: 'low', label: 'Low', color: '#6b7785', weight: 1 },
  { id: 'medium', label: 'Medium', color: '#a3b0bd', weight: 2 },
  { id: 'high', label: 'High', color: '#f2b94b', weight: 3 },
  { id: 'critical', label: 'Critical', color: '#f06a6a', weight: 4 },
]

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

export const MEMBER_STATUS_LABEL: Record<MemberStatus, string> = {
  active: 'Active', invited: 'Invited', pending: 'Pending', suspended: 'Suspended',
}

export const statusMeta = (s: TaskStatus) => STATUSES.find(x => x.id === s)!
export const priorityMeta = (p: Priority) => PRIORITIES.find(x => x.id === p)!

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export const todayIso = () => iso(new Date())

export function plusDaysIso(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return iso(d)
}

export function isOverdue(due: string | null, status: TaskStatus) {
  if (!due || status === 'done') return false
  return due < todayIso()
}

const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' })
export function timeAgo(value: string | null) {
  if (!value) return 'никогда'
  const diff = (new Date(value).getTime() - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'только что'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
  return new Date(value).toLocaleDateString('ru-RU')
}

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '—'

export const fmtDateTime = (value: string) =>
  new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

export function pluralTasks(n: number): string {
  const mod10 = n % 10, mod100 = n % 100
  const word = mod100 >= 11 && mod100 <= 14 ? 'задач' : mod10 === 1 ? 'задача' : mod10 >= 2 && mod10 <= 4 ? 'задачи' : 'задач'
  return `${n} ${word}`
}

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')

/** «12.5000 USD» → «12,5 USD»: numeric из БД приходит с хвостом нулей. */
const fmtNum = (v: string | null | undefined) =>
  (v ?? '—').replace(/-?\d+(\.\d+)?/, n => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 4 }))

/** Текст события журнала. Собирается из action + meta, которые записал триггер БД. */
export function describeActivity(e: ActivityEvent, byUser: (id: string | null) => Member | undefined): string {
  const who = byUser(e.actor_id)?.name ?? 'Кто-то'
  const m = e.meta
  const title = m.title ? `«${m.title}»` : 'задачу'
  const st = (s: string | null | undefined) => (s ? STATUSES.find(x => x.id === s)?.label ?? s : '—')
  const pr = (p: string | null | undefined) => (p ? PRIORITIES.find(x => x.id === p)?.label ?? p : '—')
  switch (e.action) {
    case 'task.created': return `${who} создал(а) задачу ${title}`
    case 'task.status': return `${who} изменил(а) статус ${title}: ${st(m.from)} → ${st(m.to)}`
    case 'task.assigned': {
      const to = m.to ? byUser(m.to)?.name ?? 'участника' : null
      if (m.to && m.to === e.actor_id) return `${who} взял(а) в работу ${title}`
      if (!m.to && m.from && m.from === e.actor_id) return `${who} отказался(лась) от ${title}`
      return to ?`${who} назначил(а) ${title} на ${to}` : `${who} снял(а) исполнителя с ${title}`
    }
    case 'task.priority': return `${who} изменил(а) приоритет ${title}: ${pr(m.from)} → ${pr(m.to)}`
    case 'task.due': return `${who} изменил(а) срок ${title}: ${fmtDate(m.from)} → ${fmtDate(m.to)}`
    case 'task.edited': return `${who} отредактировал(а) ${title}`
    case 'task.archived': return `${who} архивировал(а) ${title}`
    case 'task.restored': return `${who} вернул(а) из архива ${title}`
    case 'comment.created': return `${who} прокомментировал(а) ${title}`
    case 'file.uploaded': return `${who} загрузил(а) файл ${m.filename ?? ''} в ${title}`
    case 'member.invited': return `${who} пригласил(а) ${m.name ?? 'участника'} (${m.role ?? ''})`
    case 'member.joined': return `${m.name ?? who} присоединился(лась) к команде`
    case 'component.created': return `${who} добавил(а) компонент «${m.title}»`
    case 'component.price': return `${who} изменил(а) цену «${m.title}»: ${fmtNum(m.from)} → ${fmtNum(m.to)}`
    case 'component.stock': return `${who} изменил(а) остаток «${m.title}»: ${fmtNum(m.from)} → ${fmtNum(m.to)} ${m.unit ?? ''}`.trimEnd()
    case 'component.archived': return `${who} убрал(а) в архив компонент «${m.title}»`
    case 'component.restored': return `${who} вернул(а) из архива компонент «${m.title}»`
    case 'product.created': return `${who} добавил(а) изделие «${m.title}»`
    case 'product.status': return `${who} изменил(а) статус изделия «${m.title}»: ${m.from ?? '—'} → ${m.to ?? '—'}`
    case 'product.price': return `${who} изменил(а) цену изделия «${m.title}»: ${fmtNum(m.from)} → ${fmtNum(m.to)}`
    case 'product.archived': return `${who} убрал(а) в архив изделие «${m.title}»`
    case 'product.restored': return `${who} вернул(а) из архива изделие «${m.title}»`
    case 'assembly.created': return `${who} добавил(а) узел «${m.title}»`
    case 'assembly.override': return m.to ? `${who} задал(а) ручную стоимость узла «${m.title}»: ${fmtNum(m.to)} ₽` : `${who} вернул(а) расчётную стоимость узла «${m.title}»`
    case 'bom.added': return `${who} добавил(а) в «${m.title}»: ${m.child} × ${fmtNum(m.to)}`
    case 'bom.removed': return `${who} убрал(а) из «${m.title}»: ${m.child}`
    case 'bom.qty': return `${who} изменил(а) количество ${m.child} в «${m.title}»: ${fmtNum(m.from)} → ${fmtNum(m.to)}`
    case 'expense.created': return `${who} добавил(а) расход «${m.title}» на ${fmtNum(m.to)} ₽${m.product ? ` (${m.product})` : ''}`
    case 'expense.edited': return `${who} изменил(а) расход «${m.title}»: ${fmtNum(m.to)} ₽`
    case 'expense.deleted': return `${who} удалил(а) расход «${m.title}»`
    case 'supplier.created': return `${who} добавил(а) поставщика «${m.title}»`
    default: return `${who}: ${e.action}`
  }
}

export const DOC_TYPES: { id: DocType; label: string }[] = [
  { id: 'drawing', label: 'Чертёж / схема' },
  { id: 'datasheet', label: 'Datasheet' },
  { id: 'photo', label: 'Фото' },
  { id: 'manual', label: 'Инструкция' },
  { id: 'technical', label: 'Техдокумент' },
  { id: 'commercial', label: 'Коммерческий' },
  { id: 'receipt', label: 'Чек / счёт' },
  { id: 'other', label: 'Прочее' },
]
export const docTypeLabel = (t: DocType) => DOC_TYPES.find(x => x.id === t)?.label ?? t

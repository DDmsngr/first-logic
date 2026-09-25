import { presenceLabel } from '../presence'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, UserPlus } from 'lucide-react'
import {
  deleteInvitedMember, fetchInvitations, fetchTasks, inviteMember, reissueInvitation, updateMember,
} from '../api'
import { useWorkspace } from '../auth'
import { MEMBER_STATUS_LABEL, ROLE_LABEL } from '../meta'
import type { Member, Role } from '../types'
import { Avatar, Field, Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'

const inviteUrl = (token: string) => `${location.origin}${import.meta.env.BASE_URL}invite#${token}`

export default function Team() {
  const { members, project, isAdmin, isOwner, workspace, me } = useWorkspace()
  const [inviting, setInviting] = useState(false)
  const [link, setLink] = useState<{ name: string; url: string } | null>(null)
  const qc = useQueryClient()
  const toast = useToast()

  const tasks = useQuery({ queryKey: ['tasks', project.id, { sort: 'priority' }], queryFn: () => fetchTasks(project.id, { sort: 'priority' }) })
  const invitations = useQuery({ queryKey: ['invitations', workspace.id], queryFn: () => fetchInvitations(workspace.id), enabled: isAdmin })

  const refresh = () => { qc.invalidateQueries({ queryKey: ['members'] }); qc.invalidateQueries({ queryKey: ['invitations'] }) }
  const mutate = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: e => toast(errMsg(e), 'error'),
  })
  const reissue = useMutation({
    mutationFn: (m: Member) => reissueInvitation(m.id).then(token => ({ m, token })),
    onSuccess: ({ m, token }) => { setLink({ name: m.name, url: inviteUrl(token) }); refresh() },
    onError: e => toast(errMsg(e), 'error'),
  })

  const groups: { title: string; items: Member[] }[] = [
    { title: 'Команда', items: members.filter(m => m.status === 'active') },
    { title: 'Приглашены', items: members.filter(m => m.status === 'invited' || m.status === 'pending') },
    { title: 'Приостановлены', items: members.filter(m => m.status === 'suspended') },
  ]

  return (
    <>
      <PageHeader title="Команда" sub={`${members.filter(m => m.status === 'active').length} активных участников`}
        actions={isAdmin && <button className="dash-btn" onClick={() => setInviting(true)}><UserPlus className="h-4 w-4" aria-hidden /> Пригласить</button>} />

      {groups.filter(g => g.items.length > 0).map(g => (
        <section key={g.title} className="mb-6" aria-label={g.title}>
          <h2 className="dash-label mb-3">{g.title}</h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map(m => {
              const mine = (tasks.data ?? []).filter(t => t.assignee_id === m.user_id)
              const current = mine.filter(t => t.status !== 'done' && t.status !== 'backlog').length
              const done = mine.filter(t => t.status === 'done').length
              return (
                <li key={m.id} className="dash-card min-w-0 p-4" data-testid={`member-${m.email}`}>
                  <div className="flex items-center gap-3">
                    <Avatar member={m} size={40} />
                    <div className="min-w-0 flex-1">
                      {m.user_id
                        ? <Link to={`/team/${m.user_id}`} className="block truncate font-medium hover:underline">{m.name}</Link>
                        : <span className="block truncate font-medium">{m.name}</span>}
                      {m.position && <div className="truncate text-xs">{m.position}</div>}
                      <div className="dash-muted truncate text-xs">{m.email}</div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <span className="dash-chip">{ROLE_LABEL[m.role]}</span>
                    <span className="dash-chip">{MEMBER_STATUS_LABEL[m.status]}</span>
                  </div>
                  {m.status === 'active' && (
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                      <div><dd className="text-lg font-semibold tabular-nums">{current}</dd><dt className="dash-muted">в работе</dt></div>
                      <div><dd className="text-lg font-semibold tabular-nums">{done}</dd><dt className="dash-muted">выполнено</dt></div>
                      <div><dd className="pt-1.5 text-xs">{presenceLabel(m)}</dd><dt className="dash-muted">{m.user_id === me.user_id ? 'активность: так видят вас' : 'активность'}</dt></div>
                    </dl>
                  )}
                  {isAdmin && m.user_id !== me.user_id && m.role !== 'owner' && (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--d-line)] pt-3">
                      {(m.status === 'active' || m.status === 'invited') && isOwner && (
                        <select className="dash-input !min-h-8 !w-auto text-xs" aria-label={`Роль ${m.name}`} value={m.role}
                          onChange={e => mutate.mutate(() => updateMember(m.id, { role: e.target.value as Role }))}>
                          <option value="member">Member</option><option value="admin">Admin</option>
                        </select>
                      )}
                      {m.status === 'active' && <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => confirm(`Приостановить доступ ${m.name}?`) && mutate.mutate(() => updateMember(m.id, { status: 'suspended' }))}>Приостановить</button>}
                      {m.status === 'suspended' && <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => mutate.mutate(() => updateMember(m.id, { status: 'active' }))}>Вернуть доступ</button>}
                      {m.status === 'invited' && (
                        <>
                          <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={reissue.isPending} onClick={() => reissue.mutate(m)}>Новая ссылка</button>
                          <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => confirm(`Отозвать приглашение ${m.name}?`) && mutate.mutate(() => deleteInvitedMember(m.id))}>Отозвать</button>
                        </>
                      )}
                    </div>
                  )}
                  {m.status === 'invited' && invitations.data && (
                    <p className="dash-muted mt-2 text-xs">
                      {(() => { const i = invitations.data.find(x => x.member_id === m.id); return i ? `Ссылка действует до ${new Date(i.expires_at).toLocaleDateString('ru-RU')}` : 'Приглашение просрочено — выпустите новую ссылку' })()}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      <QueryState loading={false} error={invitations.error} onRetry={() => invitations.refetch()}><></></QueryState>

      <InviteModal open={inviting} onClose={() => setInviting(false)}
        onCreated={(name, token) => { setInviting(false); setLink({ name, url: inviteUrl(token) }); refresh() }} />
      <Modal open={!!link} onClose={() => setLink(null)} title={`Ссылка для ${link?.name ?? ''}`}>
        <p className="dash-muted mb-3 text-sm">
          Письмо не отправляется — передайте ссылку человеку сами (мессенджером). Она показывается один раз,
          действует 14 дней и работает только с email из приглашения.
        </p>
        <input readOnly className="dash-input mb-3 font-mono text-xs" aria-label="Ссылка-приглашение" value={link?.url ?? ''} onFocus={e => e.target.select()} data-testid="invite-link" />
        <div className="flex justify-end gap-2">
          <button className="dash-btn dash-btn-ghost" onClick={() => setLink(null)}>Закрыть</button>
          <button className="dash-btn" onClick={() => { void navigator.clipboard?.writeText(link!.url); toast('Ссылка скопирована') }}>
            <Copy className="h-4 w-4" aria-hidden /> Копировать
          </button>
        </div>
      </Modal>
    </>
  )
}

function InviteModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (name: string, token: string) => void }) {
  const { workspace, isOwner } = useWorkspace()
  const toast = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [message, setMessage] = useState('')
  const invite = useMutation({
    mutationFn: () => inviteMember(workspace.id, name.trim(), email.trim(), role, message),
    onSuccess: token => { onCreated(name.trim(), token); setName(''); setEmail(''); setMessage(''); setRole('member') },
    onError: e => toast(errMsg(e), 'error'),
  })
  const submit = (e: FormEvent) => { e.preventDefault(); invite.mutate() }
  return (
    <Modal open={open} onClose={onClose} title="Пригласить участника">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Имя"><input className="dash-input" required autoFocus value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Email"><input className="dash-input" type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Роль">
          <select className="dash-input" value={role} onChange={e => setRole(e.target.value as 'admin' | 'member')}>
            <option value="member">Member — работает со своими задачами</option>
            {isOwner && <option value="admin">Admin — управляет задачами и людьми</option>}
          </select>
        </Field>
        <Field label="Сообщение (необязательно)"><textarea className="dash-input" value={message} onChange={e => setMessage(e.target.value)} /></Field>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
          <button className="dash-btn" disabled={invite.isPending}>{invite.isPending ? 'Создаём…' : 'Создать приглашение'}</button>
        </div>
      </form>
    </Modal>
  )
}

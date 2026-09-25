import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import {
  fetchLabels, fetchMembers, fetchMyMemberships, fetchProjects, syncOverdue, touch,
} from './api'
import type { Label, Member, Project, Workspace } from './types'
import { QueryState } from './ui'

// ── сессия ──────────────────────────────────────────────────────────────────

interface AuthState { session: Session | null; ready: boolean }
const AuthCtx = createContext<AuthState>({ session: null, ready: false })
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, ready: false })
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setState({ session: data.session, ready: true }))
    const { data } = supabase.auth.onAuthStateChange((_e, session) => setState({ session, ready: true }))
    return () => data.subscription.unsubscribe()
  }, [])
  return <AuthCtx.Provider value={state}>{children}</AuthCtx.Provider>
}

export const signOut = () => supabase.auth.signOut()

// ── workspace ───────────────────────────────────────────────────────────────

interface WorkspaceState {
  workspace: Workspace
  project: Project
  me: Member
  userId: string
  members: Member[]
  labels: Label[]
  isAdmin: boolean
  isOwner: boolean
  /** участник по auth user id (исполнители, авторы) */
  byUser: (id: string | null | undefined) => Member | undefined
}
const WsCtx = createContext<WorkspaceState | null>(null)

export function useWorkspace() {
  const v = useContext(WsCtx)
  if (!v) throw new Error('useWorkspace вне WorkspaceProvider')
  return v
}

/**
 * Пускает дальше только активного участника. Вход в Supabase Auth сам по себе
 * ничего не даёт: auth.users общие с приложением, доступ определяет ws_members.
 */
export function WorkspaceProvider({ session, children }: { session: Session; children: ReactNode }) {
  const userId = session.user.id
  const qc = useQueryClient()

  const mem = useQuery({ queryKey: ['memberships', userId], queryFn: () => fetchMyMemberships(userId) })
  const primary = mem.data?.[0]
  const wsId = primary?.workspace_id

  const projects = useQuery({ queryKey: ['projects', wsId], queryFn: () => fetchProjects(wsId!), enabled: !!wsId })
  const members = useQuery({ queryKey: ['members', wsId], queryFn: () => fetchMembers(wsId!), enabled: !!wsId })
  const labels = useQuery({ queryKey: ['labels', wsId], queryFn: () => fetchLabels(wsId!), enabled: !!wsId })

  // присутствие + просроченные → уведомления
  useEffect(() => {
    if (!wsId) return
    const beat = () => { void touch(wsId) }
    beat()
    void syncOverdue(wsId).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }))
    const t = setInterval(beat, 120_000)
    return () => clearInterval(t)
  }, [wsId, qc])

  // realtime: любое изменение чужих данных → перечитать нужные запросы
  useEffect(() => {
    if (!wsId) return
    const ch = supabase.channel(`ws-${wsId}`)
    const on = (table: string, keys: string[]) =>
      ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        keys.forEach(k => qc.invalidateQueries({ queryKey: [k] }))
      })
    on('ws_tasks', ['tasks', 'task', 'stats', 'activity'])
    on('ws_task_labels', ['tasks', 'task'])
    on('ws_labels', ['labels'])
    on('ws_members', ['members'])
    on('ws_comments', ['comments', 'tasks', 'activity'])
    on('ws_attachments', ['attachments', 'tasks', 'task', 'activity'])
    on('ws_messages', ['messages', 'unread'])
    on('ws_conversations', ['conversations', 'unread'])
    on('ws_notifications', ['notifications'])
    on('fl_components', ['components', 'component', 'activity'])
    on('fl_suppliers', ['suppliers', 'supplier'])
    on('fl_dicts', ['dicts'])
    on('fl_rates', ['rates'])
    on('fl_products', ['products', 'product', 'activity'])
    on('fl_assemblies', ['assemblies', 'assembly', 'activity'])
    on('fl_bom_items', ['bom', 'activity'])
    on('fl_expenses', ['expenses', 'activity'])
    ch.subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [wsId, qc])

  const value = useMemo<WorkspaceState | null>(() => {
    if (!primary || !projects.data?.[0] || !members.data || !labels.data) return null
    const { ws_workspaces, ...me } = primary
    const byId = new Map(members.data.filter(m => m.user_id).map(m => [m.user_id!, m]))
    return {
      workspace: ws_workspaces, project: projects.data[0], me, userId,
      members: members.data, labels: labels.data,
      isAdmin: me.role === 'owner' || me.role === 'admin',
      isOwner: me.role === 'owner',
      byUser: id => (id ? byId.get(id) : undefined),
    }
  }, [primary, projects.data, members.data, labels.data, userId])

  const loading = mem.isLoading || (!!wsId && (projects.isLoading || members.isLoading || labels.isLoading))
  const error = mem.error ?? projects.error ?? members.error ?? labels.error
  const retry = () => { void mem.refetch(); void projects.refetch(); void members.refetch(); void labels.refetch() }

  if (!loading && !error && mem.data && mem.data.length === 0) return <NoAccess email={session.user.email ?? ''} />
  if (!value) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <QueryState loading={loading} error={error} onRetry={retry}><></></QueryState>
      </div>
    )
  }
  return <WsCtx.Provider value={value}>{children}</WsCtx.Provider>
}

function NoAccess({ email }: { email: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-semibold">Нет доступа к рабочему пространству</h1>
      <p className="dash-muted text-sm">
        Аккаунт <b className="text-[var(--d-text)]">{email}</b> не состоит в команде First Logic.
        Попросите владельца прислать приглашение на этот email.
      </p>
      <button className="dash-btn dash-btn-ghost" onClick={() => void signOut()}>Выйти</button>
    </main>
  )
}

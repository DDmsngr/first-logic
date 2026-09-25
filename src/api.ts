import { supabase } from './supabase'
import type {
  ActivityEvent, Attachment, Conversation, Invitation, Label, Member, Message,
  Notification, Project, Task, TaskComment, TaskFilters, TaskStatus, Workspace,
} from './types'
import { PRIORITIES, plusDaysIso, todayIso } from './meta'

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

export const PAGE = 20

// ── workspace ───────────────────────────────────────────────────────────────

export async function fetchMyMemberships(userId: string) {
  return check(await supabase
    .from('ws_members')
    .select('*, ws_workspaces(*)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at')) as (Member & { ws_workspaces: Workspace })[]
}

export async function fetchProjects(workspaceId: string) {
  return check(await supabase.from('ws_projects').select('*')
    .eq('workspace_id', workspaceId).is('archived_at', null).order('created_at')) as Project[]
}

export async function fetchMembers(workspaceId: string) {
  return check(await supabase.from('ws_members').select('*')
    .eq('workspace_id', workspaceId).order('created_at')) as Member[]
}

export async function fetchLabels(workspaceId: string) {
  return check(await supabase.from('ws_labels').select('*')
    .eq('workspace_id', workspaceId).order('name')) as Label[]
}

export const touch = (workspaceId: string) => supabase.rpc('ws_touch', { p_ws: workspaceId })

// ── задачи ──────────────────────────────────────────────────────────────────

const TASK_SELECT = '*, ws_task_labels(label_id), ws_comments(count), ws_attachments(count)'

type TaskRow = Omit<Task, 'label_ids' | 'comment_count' | 'attachment_count'> & {
  ws_task_labels: { label_id: string }[]
  ws_comments: { count: number }[]
  ws_attachments: { count: number }[]
}

const mapTask = (r: TaskRow): Task => {
  const { ws_task_labels, ws_comments, ws_attachments, ...t } = r
  return {
    ...t,
    label_ids: ws_task_labels.map(l => l.label_id),
    comment_count: ws_comments[0]?.count ?? 0,
    attachment_count: ws_attachments[0]?.count ?? 0,
  }
}

// экранирование для ilike и для or()-синтаксиса PostgREST
const escapeLike = (s: string) => s.replace(/[\\%_]/g, m => '\\' + m).replace(/[,()]/g, ' ')

export async function fetchTasks(projectId: string, f: TaskFilters, limit = 300) {
  let q = supabase.from('ws_tasks').select(TASK_SELECT).eq('project_id', projectId).is('archived_at', null)
  if (f.status?.length) q = q.in('status', f.status)
  if (f.priority?.length) q = q.in('priority', f.priority)
  if (f.assignee === 'none') q = q.is('assignee_id', null)
  else if (f.assignee) q = q.eq('assignee_id', f.assignee)
  if (f.due === 'overdue') q = q.lt('due_date', todayIso()).neq('status', 'done')
  if (f.due === 'week') q = q.gte('due_date', todayIso()).lte('due_date', plusDaysIso(7)).neq('status', 'done')
  if (f.due === 'none') q = q.is('due_date', null)
  if (f.q?.trim()) {
    const like = `%${escapeLike(f.q.trim())}%`
    q = q.or(`title.ilike.${like},description.ilike.${like}`)
  }
  if (f.label) {
    const ids = check(await supabase.from('ws_task_labels').select('task_id').eq('label_id', f.label)) as { task_id: string }[]
    q = q.in('id', ids.length ? ids.map(i => i.task_id) : ['00000000-0000-0000-0000-000000000000'])
  }
  switch (f.sort) {
    case 'oldest': q = q.order('created_at', { ascending: true }); break
    case 'due': q = q.order('due_date', { ascending: true, nullsFirst: false }); break
    case 'updated': q = q.order('updated_at', { ascending: false }); break
    case 'newest': q = q.order('created_at', { ascending: false }); break
    default: q = q.order('position', { ascending: true })
  }
  let tasks = (check(await q.limit(limit)) as unknown as TaskRow[]).map(mapTask)
  if (f.sort === 'priority') {
    const w = (p: string) => PRIORITIES.find(x => x.id === p)!.weight
    tasks = tasks.sort((a, b) => w(b.priority) - w(a.priority) || a.position - b.position)
  }
  return tasks
}

export async function fetchTask(id: string) {
  const row = check(await supabase.from('ws_tasks').select(TASK_SELECT).eq('id', id).maybeSingle()) as unknown as TaskRow | null
  return row ? mapTask(row) : null
}

export interface NewTask {
  workspace_id: string
  project_id: string
  title: string
  description?: string
  status?: TaskStatus
  priority?: Task['priority']
  assignee_id?: string | null
  due_date?: string | null
}

export async function createTask(t: NewTask) {
  const row = check(await supabase.from('ws_tasks').insert(t).select(TASK_SELECT).single()) as unknown as TaskRow
  return mapTask(row)
}

export type TaskPatch = Partial<Pick<Task,
  'title' | 'description' | 'status' | 'priority' | 'assignee_id' | 'due_date' | 'position' | 'archived_at'>>

export async function updateTask(id: string, patch: TaskPatch) {
  const rows = check(await supabase.from('ws_tasks').update(patch).eq('id', id).select('id')) as { id: string }[]
  // RLS молча отсекает чужие строки: 0 строк — это отказ, а не успех
  if (rows.length === 0) throw new Error('Нет прав на изменение этой задачи')
}

/**
 * Массовое обновление одним запросом. Один SQL UPDATE затрагивает все строки сразу:
 * если триггер БД (правила «кто что может менять») отклонит хоть одну, откатится весь
 * запрос — поэтому вызывающая сторона обязана заранее отфильтровать id по своим правам
 * (см. BulkBar: участнику отправляются только его собственные задачи).
 */
export async function bulkUpdateTasks(ids: string[], patch: TaskPatch) {
  if (!ids.length) return 0
  const rows = check(await supabase.from('ws_tasks').update(patch).in('id', ids).select('id')) as unknown[]
  return rows.length
}

export const bulkArchiveTasks = (ids: string[]) => bulkUpdateTasks(ids, { archived_at: new Date().toISOString() })

/** Безвозвратное удаление. RLS пускает только админов; файлы задачи подчищаются из бакета отдельно. */
export async function bulkDeleteTasks(ids: string[]) {
  if (!ids.length) return { deleted: 0, filesFailed: false }
  const atts = check(await supabase.from('ws_attachments').select('storage_path').in('task_id', ids)) as { storage_path: string }[]
  const rows = check(await supabase.from('ws_tasks').delete().in('id', ids).select('id')) as unknown[]
  if (rows.length === 0) throw new Error('Нет прав на удаление этих задач')
  let filesFailed = false
  if (atts.length) {
    const rm = await supabase.storage.from(BUCKET).remove(atts.map(a => a.storage_path))
    filesFailed = !!rm.error
  }
  return { deleted: rows.length, filesFailed }
}

export async function bulkAddLabel(ids: string[], labelId: string) {
  if (!ids.length) return
  check(await supabase.from('ws_task_labels')
    .upsert(ids.map(task_id => ({ task_id, label_id: labelId })), { onConflict: 'task_id,label_id', ignoreDuplicates: true }))
}

export async function bulkRemoveLabel(ids: string[], labelId: string) {
  if (!ids.length) return
  check(await supabase.from('ws_task_labels').delete().eq('label_id', labelId).in('task_id', ids))
}

export interface ImportPayload {
  title: string; description: string; status: TaskStatus; priority: Task['priority']
  assignee_id: string | null; due_date: string | null; labels: string[]
}

/** Пакетное создание одной транзакцией: либо все задачи, либо ни одной. */
export async function importTasks(projectId: string, rows: ImportPayload[]) {
  return check(await supabase.rpc('ws_import_tasks', { p_project: projectId, p_tasks: rows })) as
    { id: string; num: number; title: string }[]
}

/** Взять свободную задачу: атомарно на стороне БД, двое одновременно не возьмут. */
export async function claimTask(id: string) {
  check(await supabase.rpc('ws_claim_task', { p_task: id }))
}

export async function releaseTask(id: string) {
  check(await supabase.rpc('ws_release_task', { p_task: id }))
}

export async function setTaskLabels(taskId: string, labelIds: string[]) {
  check(await supabase.from('ws_task_labels').delete().eq('task_id', taskId))
  if (labelIds.length) {
    check(await supabase.from('ws_task_labels').insert(labelIds.map(label_id => ({ task_id: taskId, label_id }))))
  }
}

export async function createLabel(workspaceId: string, name: string, color: string) {
  return check(await supabase.from('ws_labels').insert({ workspace_id: workspaceId, name, color }).select().single()) as Label
}

export async function fetchStats(projectId: string) {
  return check(await supabase.rpc('ws_project_stats', { p_project: projectId })) as Record<string, number>
}

// ── комментарии ─────────────────────────────────────────────────────────────

export async function fetchComments(taskId: string) {
  return check(await supabase.from('ws_comments').select('*').eq('task_id', taskId)
    .order('created_at')) as TaskComment[]
}

export async function addComment(taskId: string, body: string, parentId: string | null, mentions: string[]) {
  check(await supabase.from('ws_comments').insert({ task_id: taskId, body, parent_id: parentId, mentions }))
}

export async function editComment(id: string, body: string) {
  const rows = check(await supabase.from('ws_comments').update({ body }).eq('id', id).select('id')) as unknown[]
  if (!rows.length) throw new Error('Можно править только свои комментарии')
}

export async function deleteComment(id: string) {
  const rows = check(await supabase.from('ws_comments')
    .update({ deleted_at: new Date().toISOString(), body: '(удалено)' }).eq('id', id).select('id')) as unknown[]
  if (!rows.length) throw new Error('Можно удалять только свои комментарии')
}

// ── файлы ───────────────────────────────────────────────────────────────────

const BUCKET = 'ws-files'
export const MAX_FILE = 25 * 1024 * 1024

const safeName = (n: string) => n.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120)

export async function uploadFile(
  workspaceId: string, userId: string, file: File, target: { taskId?: string; messageId?: string },
) {
  if (file.size > MAX_FILE) throw new Error('Файл больше 25 МБ')
  const path = `${workspaceId}/${userId}/${crypto.randomUUID()}-${safeName(file.name)}`
  const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined })
  if (up.error) throw new Error(up.error.message)
  const ins = await supabase.from('ws_attachments').insert({
    task_id: target.taskId ?? null, message_id: target.messageId ?? null,
    storage_path: path, filename: file.name, mime: file.type || null, size: file.size,
  }).select().single()
  if (ins.error) {
    await supabase.storage.from(BUCKET).remove([path]) // не оставляем сироту без записи
    throw new Error(ins.error.message)
  }
  return ins.data as Attachment
}

export async function fetchAttachment(id: string) {
  return check(await supabase.from('ws_attachments').select('*').eq('id', id).maybeSingle()) as Attachment | null
}

export const isImage = (a: Pick<Attachment, 'mime' | 'filename'>) =>
  (a.mime ?? '').startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(a.filename)

/** Подпись файла внутри задачи: скрин-1, скрин-2 (картинки) и файл-1, файл-2 (остальное). */
export function fileLabels(files: Pick<Attachment, 'id' | 'mime' | 'filename' | 'created_at'>[]) {
  const out = new Map<string, string>()
  let img = 0, other = 0
  for (const f of [...files].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    out.set(f.id, isImage(f) ? `скрин-${++img}` : `файл-${++other}`)
  }
  return out
}

export async function fetchAttachments(opts: {
  taskId?: string; workspaceId?: string; messageIds?: string[]; page?: number; q?: string
}) {
  let q = supabase.from('ws_attachments').select('*').order('created_at', { ascending: false })
  if (opts.taskId) q = q.eq('task_id', opts.taskId)
  if (opts.workspaceId) q = q.eq('workspace_id', opts.workspaceId)
  if (opts.messageIds) q = q.in('message_id', opts.messageIds)
  if (opts.q?.trim()) q = q.ilike('filename', `%${escapeLike(opts.q.trim())}%`)
  if (opts.page !== undefined) q = q.range(opts.page * PAGE, opts.page * PAGE + PAGE - 1)
  return check(await q) as Attachment[]
}

/** Подписанная ссылка на минуту: файлы приватные, публичного URL у них нет. */
export async function signedUrl(path: string, download?: string, ttl = 60) {
  const res = await supabase.storage.from(BUCKET).createSignedUrl(path, ttl, download ? { download } : undefined)
  if (res.error) throw new Error(res.error.message)
  return res.data.signedUrl
}

export async function deleteAttachment(a: Attachment) {
  const rows = check(await supabase.from('ws_attachments').delete().eq('id', a.id).select('id')) as unknown[]
  if (!rows.length) throw new Error('Удалять может загрузивший или админ')
  await supabase.storage.from(BUCKET).remove([a.storage_path])
}

// ── журнал ──────────────────────────────────────────────────────────────────

export async function fetchActivity(workspaceId: string, page: number, only: { entityId?: string; actorId?: string } = {}) {
  let q = supabase.from('ws_activity').select('*').eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1)
  if (only.entityId) q = q.eq('entity_id', only.entityId)
  if (only.actorId) q = q.eq('actor_id', only.actorId)
  return check(await q) as ActivityEvent[]
}

// ── уведомления ─────────────────────────────────────────────────────────────

export async function fetchNotifications(workspaceId: string) {
  return check(await supabase.from('ws_notifications').select('*').eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false }).limit(50)) as Notification[]
}

export async function markNotifications(ids: string[]) {
  if (!ids.length) return
  check(await supabase.from('ws_notifications').update({ read_at: new Date().toISOString() }).in('id', ids))
}

export const syncOverdue = (workspaceId: string) => supabase.rpc('ws_sync_overdue', { p_ws: workspaceId })

// ── чат ─────────────────────────────────────────────────────────────────────

export async function fetchConversations(workspaceId: string) {
  return check(await supabase.from('ws_conversations').select('*').eq('workspace_id', workspaceId)
    .order('created_at')) as Conversation[]
}

export async function fetchUnread(workspaceId: string) {
  const rows = check(await supabase.rpc('ws_unread_counts', { p_ws: workspaceId })) as
    { conversation_id: string; unread: number }[]
  return Object.fromEntries(rows.map(r => [r.conversation_id, Number(r.unread)])) as Record<string, number>
}

export async function fetchMessages(conversationId: string, before?: string) {
  let q = supabase.from('ws_messages').select('*').eq('conversation_id', conversationId)
    .order('created_at', { ascending: false }).limit(30)
  if (before) q = q.lt('created_at', before)
  return (check(await q) as Message[]).reverse()
}

export async function sendMessage(conversationId: string, body: string, taskId: string | null = null) {
  return check(await supabase.from('ws_messages').insert({ conversation_id: conversationId, body, task_id: taskId })
    .select().single()) as Message
}

export async function createGroup(workspaceId: string, name: string, members: string[]) {
  return check(await supabase.rpc('ws_create_group', { p_ws: workspaceId, p_name: name, p_members: members })) as string
}

export async function addGroupMembers(conversationId: string, members: string[]) {
  check(await supabase.rpc('ws_group_add_members', { p_conv: conversationId, p_members: members }))
}

export async function fetchConvMembers(conversationId: string) {
  return check(await supabase.rpc('ws_conv_members', { p_conv: conversationId })) as string[]
}

export async function openDirect(workspaceId: string, otherUserId: string) {
  return check(await supabase.rpc('ws_open_direct', { p_ws: workspaceId, p_other: otherUserId })) as string
}

export const markRead = (conversationId: string) => supabase.rpc('ws_mark_read', { p_conv: conversationId })

// ── команда и приглашения ───────────────────────────────────────────────────

export async function inviteMember(
  workspaceId: string, name: string, email: string, role: 'admin' | 'member', message: string,
) {
  return check(await supabase.rpc('ws_invite_member', {
    p_ws: workspaceId, p_name: name, p_email: email, p_role: role, p_message: message || null,
  })) as string
}

export async function reissueInvitation(memberId: string) {
  return check(await supabase.rpc('ws_reissue_invitation', { p_member: memberId })) as string
}

export async function updateMember(id: string, patch: Partial<Pick<Member, 'role' | 'status'>>) {
  const rows = check(await supabase.from('ws_members').update(patch).eq('id', id).select('id')) as unknown[]
  if (!rows.length) throw new Error('Нет прав на изменение участника')
}

export async function deleteInvitedMember(id: string) {
  const rows = check(await supabase.from('ws_members').delete().eq('id', id).select('id')) as unknown[]
  if (!rows.length) throw new Error('Отозвать можно только непринятое приглашение')
}

export async function fetchInvitations(workspaceId: string) {
  return check(await supabase.from('ws_invitations').select('id, member_id, status, expires_at, message')
    .eq('workspace_id', workspaceId).eq('status', 'invited')) as Invitation[]
}

export async function invitationPreview(token: string) {
  const rows = check(await supabase.rpc('ws_invitation_preview', { p_token: token })) as {
    workspace_name: string; name: string; email: string; role: string; message: string | null
  }[]
  return rows[0] ?? null
}

export async function acceptInvitation(token: string) {
  return check(await supabase.rpc('ws_accept_invitation', { p_token: token })) as string
}

// ── поиск ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  tasks: { id: string; num: number; title: string; status: TaskStatus }[]
  members: { user_id: string; name: string; email: string; role: string }[]
  messages: { id: string; conversation_id: string; body: string; created_at: string }[]
  files: { id: string; task_id: string | null; filename: string; size: number }[]
}

export async function search(workspaceId: string, q: string) {
  return check(await supabase.rpc('ws_search', { p_ws: workspaceId, p_q: q })) as SearchResult
}

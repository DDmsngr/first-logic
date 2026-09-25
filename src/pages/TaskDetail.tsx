import { ProductSelect } from '../catalogParts'
import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArrowLeft, MessageSquarePlus, Paperclip, Pencil, Reply, Trash2, X } from 'lucide-react'
import {
  addComment, createLabel, deleteComment, editComment, fetchAttachments, fetchComments, fetchConversations,
  fetchTask, isImage, sendMessage, setTaskLabels, uploadFile,
} from '../api'
import { useWorkspace } from '../auth'
import { PRIORITIES, STATUSES, fmtDateTime, timeAgo } from '../meta'
import type { Attachment, Priority, TaskComment, TaskStatus } from '../types'
import { Avatar, DateInput, Field, QueryState, errMsg, useToast } from '../ui'
import Md from '../Md'
import { ActivityList, FileList, UploadButton } from '../shared'
import { ClaimButton, LabelChips, PriorityChip, StatusChip, useTaskUpdate } from '../taskParts'

const ADMIN_ONLY_HINT = 'Изменить может только owner или admin'

export default function TaskDetail() {
  const { id = '' } = useParams()
  const { members, byUser, isAdmin, userId, labels, workspace } = useWorkspace()
  const qc = useQueryClient()
  const nav = useNavigate()
  const toast = useToast()
  const update = useTaskUpdate()

  const task = useQuery({ queryKey: ['task', id], queryFn: () => fetchTask(id) })
  const t = task.data
  const isAssignee = !!t && t.assignee_id === userId
  const canStatus = isAdmin || isAssignee
  const [editingDesc, setEditingDesc] = useState(false)
  const [desc, setDesc] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState('')

  const files = useQuery({ queryKey: ['attachments', 'task', id], queryFn: () => fetchAttachments({ taskId: id }), enabled: !!t })

  const labelsMut = useMutation({
    mutationFn: (ids: string[]) => setTaskLabels(id, ids),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['task', id] }); qc.invalidateQueries({ queryKey: ['tasks'] }) },
    onError: e => toast(errMsg(e), 'error'),
  })
  const [newLabel, setNewLabel] = useState('')
  const addLabel = useMutation({
    mutationFn: async () => {
      const l = await createLabel(workspace.id, newLabel.trim(), '#5ec4e6')
      await setTaskLabels(id, [...(t?.label_ids ?? []), l.id])
    },
    onSuccess: () => { setNewLabel(''); qc.invalidateQueries({ queryKey: ['labels'] }); qc.invalidateQueries({ queryKey: ['task', id] }); qc.invalidateQueries({ queryKey: ['tasks'] }) },
    onError: e => toast(errMsg(e), 'error'),
  })

  const patch = (p: Parameters<typeof update.mutate>[0]['patch']) => update.mutate({ id, patch: p })
  const assignable = members.filter(m => m.status === 'active' && m.user_id)

  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/tasks" className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]">
        <ArrowLeft className="h-4 w-4" aria-hidden /> К задачам
      </Link>

      <QueryState loading={task.isLoading} error={task.error} onRetry={() => task.refetch()}
        empty={!t} emptyText="Задача не найдена" emptyHint="Она удалена, в архиве или у вас нет доступа.">
        {t && (
          <>
            <div className="mb-5">
              {editingTitle ? (
                <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (title.trim()) { patch({ title: title.trim() }); setEditingTitle(false) } }}>
                  <input className="dash-input text-lg font-semibold" aria-label="Название задачи" autoFocus value={title} onChange={e => setTitle(e.target.value)} />
                  <button className="dash-btn">Сохранить</button>
                </form>
              ) : (
                <h1 className="flex items-start gap-2 text-xl font-semibold tracking-tight md:text-2xl" data-testid="task-title">
                  <span className="dash-muted font-mono text-base font-normal md:text-lg">#{t.num}</span>
                  {t.title}
                  {isAdmin && (
                    <button className="dash-btn dash-btn-ghost dash-btn-sm mt-0.5" aria-label="Изменить название" onClick={() => { setTitle(t.title); setEditingTitle(true) }}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                </h1>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusChip status={t.status} /><PriorityChip priority={t.priority} /><LabelChips ids={t.label_ids} />
                {!t.assignee_id && t.status !== 'done' && <span className="dash-chip">Свободна</span>}
              </div>
              <div className="mt-3"><ClaimButton task={t} /></div>
            </div>

            <section aria-label="Параметры" className="dash-card mb-5 grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Статус">
                <select className="dash-input" disabled={!canStatus} title={canStatus ? undefined : 'Менять статус может исполнитель или owner/admin'} value={t.status} onChange={e => patch({ status: e.target.value as TaskStatus })}>
                  {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </Field>
              <Field label="Приоритет">
                <select className="dash-input" disabled={!isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_HINT} value={t.priority} onChange={e => patch({ priority: e.target.value as Priority })}>
                  {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </Field>
              <Field label="Исполнитель">
                <select className="dash-input" disabled={!isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_HINT} value={t.assignee_id ?? ''} onChange={e => patch({ assignee_id: e.target.value || null })}>
                  <option value="">Не назначен</option>
                  {assignable.map(m => <option key={m.id} value={m.user_id!}>{m.name}</option>)}
                </select>
              </Field>
              <Field label="Изделие">
                <ProductSelect disabled={!isAdmin} value={t.product_id} onChange={v => patch({ product_id: v })} />
              </Field>
              <Field label="Срок">
                <DateInput disabled={!isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_HINT} value={t.due_date ?? ''} onChange={v => patch({ due_date: v || null })} />
              </Field>
              <div>
                <span className="dash-label mb-1.5 block">Автор</span>
                <span className="flex items-center gap-2 text-sm"><Avatar member={byUser(t.creator_id)} size={24} />{byUser(t.creator_id)?.name ?? '—'}</span>
                <span className="dash-muted mt-1 block text-xs">создана {fmtDateTime(t.created_at)}</span>
              </div>
              <div>
                <span className="dash-label mb-1.5 block">Метки</span>
                <div className="flex flex-wrap gap-1.5">
                  {labels.map(l => {
                    const on = t.label_ids.includes(l.id)
                    return (
                      <button key={l.id} type="button" disabled={!isAdmin || labelsMut.isPending} aria-pressed={on}
                        onClick={() => labelsMut.mutate(on ? t.label_ids.filter(x => x !== l.id) : [...t.label_ids, l.id])}
                        className="dash-chip disabled:cursor-default" style={on ? { color: l.color, borderColor: l.color, background: l.color + '1f' } : undefined}>
                        {l.name}
                      </button>
                    )
                  })}
                  {labels.length === 0 && <span className="dash-muted text-xs">Меток пока нет</span>}
                </div>
                {isAdmin && (
                  <form className="mt-2 flex gap-1.5" onSubmit={e => { e.preventDefault(); if (newLabel.trim()) addLabel.mutate() }}>
                    <input className="dash-input !min-h-8 text-xs" placeholder="Новая метка" aria-label="Название новой метки" value={newLabel} onChange={e => setNewLabel(e.target.value)} />
                    <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={addLabel.isPending}>+</button>
                  </form>
                )}
              </div>
            </section>

            <section aria-labelledby="desc-h" className="mb-5">
              <div className="mb-2 flex items-center justify-between">
                <h2 id="desc-h" className="dash-label">Описание</h2>
                {(isAdmin || isAssignee) && !editingDesc && (
                  <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => { setDesc(t.description); setEditingDesc(true) }}>Изменить</button>
                )}
              </div>
              {editingDesc ? (
                <form className="space-y-2" onSubmit={e => { e.preventDefault(); patch({ description: desc }); setEditingDesc(false) }}>
                  <textarea className="dash-input min-h-32" aria-label="Описание задачи" value={desc} onChange={e => setDesc(e.target.value)} />
                  <div className="flex gap-2">
                    <button className="dash-btn dash-btn-sm">Сохранить</button>
                    <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setEditingDesc(false)}>Отмена</button>
                  </div>
                </form>
              ) : (
                <div className="dash-card p-4">{t.description ? <Md>{t.description}</Md> : <span className="dash-muted text-sm">Описания нет</span>}</div>
              )}
            </section>

            <section aria-labelledby="disc-h" className="mb-5">
              <h2 id="disc-h" className="dash-label mb-2">Обсуждение</h2>
              <Discussion taskId={id} files={files.data ?? []} />
            </section>

            <section aria-labelledby="files-h" className="mb-5">
              <div className="mb-2 flex items-center justify-between">
                <h2 id="files-h" className="dash-label">Файлы</h2>
                <UploadButton target={{ taskId: id }} />
              </div>
              <div className="dash-card px-4 py-1">
                <QueryState loading={files.isLoading} error={files.error} onRetry={() => files.refetch()} empty={files.data?.length === 0} emptyText="Файлов нет">
                  <FileList files={files.data ?? []} />
                </QueryState>
              </div>
            </section>

            <section aria-labelledby="act-h" className="mb-5">
              <h2 id="act-h" className="dash-label mb-2">Активность</h2>
              <div className="dash-card p-4"><ActivityList entityId={id} /></div>
            </section>

            <SendToChat taskId={id} num={t.num} />

            {isAdmin && (
              <button className="dash-btn dash-btn-ghost mt-3" onClick={() => {
                if (confirm('Архивировать задачу? Она исчезнет с доски, история сохранится.')) {
                  update.mutate({ id, patch: { archived_at: new Date().toISOString() } }, { onSuccess: () => { toast('Задача в архиве'); nav('/tasks') } })
                }
              }}>
                <Archive className="h-4 w-4" aria-hidden /> Архивировать
              </button>
            )}
          </>
        )}
      </QueryState>
    </div>
  )
}

interface Pending { file: File; label: string }

function Discussion({ taskId, files }: { taskId: string; files: Attachment[] }) {
  const { members, byUser, userId, workspace } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const list = useQuery({ queryKey: ['comments', taskId], queryFn: () => fetchComments(taskId), refetchInterval: 8000 })
  const [body, setBody] = useState('')
  const [mentions, setMentions] = useState<Record<string, string>>({})
  const [replyTo, setReplyTo] = useState<TaskComment | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const picker = useRef<HTMLInputElement>(null)

  const refresh = () => {
    for (const k of ['comments', 'tasks', 'task', 'activity', 'attachments']) qc.invalidateQueries({ queryKey: [k] })
  }

  /** Подпись следующего файла: продолжает нумерацию уже загруженных и выбранных. */
  const nextLabel = (file: File, taken: Pending[]) => {
    const img = isImage({ mime: file.type, filename: file.name })
    const used = [...files.map(f => ({ mime: f.mime, filename: f.filename })), ...taken.map(p => ({ mime: p.file.type, filename: p.file.name }))]
    const n = used.filter(u => isImage(u) === img).length + 1
    return `${img ? 'скрин' : 'файл'}-${n}`
  }

  // выбранные файлы сразу попадают в текст ссылками [скрин-N]: заменятся на настоящие при отправке
  const attach = (chosen: File[]) => {
    if (!chosen.length) return
    const added: Pending[] = []
    for (const file of chosen) added.push({ file, label: nextLabel(file, [...pending, ...added]) })
    setPending(p => [...p, ...added])
    setBody(b => `${b}${b && !/\s$/.test(b) ? ' ' : ''}${added.map(a => `[${a.label}]`).join(' ')} `)
  }
  const unattach = (label: string) => {
    setPending(p => p.filter(x => x.label !== label))
    setBody(b => b.replace(`[${label}] `, '').replace(`[${label}]`, ''))
  }

  const add = useMutation({
    mutationFn: async () => {
      let text = body.trim()
      const failed: string[] = []
      for (const p of pending) {
        try {
          const a = await uploadFile(workspace.id, userId, p.file, { taskId })
          const link = `[${p.label}](/files/${a.id})`
          text = text.includes(`[${p.label}]`) ? text.replace(`[${p.label}]`, link) : `${text} ${link}`
        } catch (e) {
          failed.push(`${p.file.name}: ${errMsg(e)}`)
          text = text.replace(`[${p.label}]`, `~~${p.label}~~ (не загрузился)`)
        }
      }
      const ids = Object.entries(mentions).filter(([, name]) => text.includes('@' + name)).map(([id]) => id)
      await addComment(taskId, text, replyTo?.id ?? null, ids)
      if (failed.length) throw new Error(`Комментарий отправлен, но не загрузились: ${failed.join('; ')}`)
    },
    onSuccess: () => { setBody(''); setMentions({}); setReplyTo(null); setPending([]); refresh() },
    onError: e => { setBody(''); setMentions({}); setReplyTo(null); setPending([]); refresh(); toast(errMsg(e), 'error') },
  })
  const submit = (e: FormEvent) => { e.preventDefault(); if (body.trim() || pending.length) add.mutate() }

  const all = list.data ?? []
  const roots = all.filter(c => !c.parent_id)
  const people = members.filter(m => m.status === 'active' && m.user_id && m.user_id !== userId)

  return (
    <div className="dash-card p-4">
      <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} empty={all.length === 0} emptyText="Пока нет сообщений" emptyHint="Начните обсуждение ниже.">
        <ul className="space-y-4" data-testid="comments">
          {roots.map(c => (
            <li key={c.id}>
              <Comment c={c} onReply={() => setReplyTo(c)} refresh={refresh} />
              <ul className="ml-9 mt-2 space-y-3 border-l border-[var(--d-line)] pl-3">
                {all.filter(r => r.parent_id === c.id).map(r => <li key={r.id}><Comment c={r} refresh={refresh} /></li>)}
              </ul>
            </li>
          ))}
        </ul>
      </QueryState>

      <form onSubmit={submit} className="mt-4 space-y-2 border-t border-[var(--d-line)] pt-4">
        {replyTo && (
          <p className="dash-muted flex items-center gap-2 text-xs">
            Ответ для {byUser(replyTo.author_id)?.name ?? 'участника'}
            <button type="button" className="underline" onClick={() => setReplyTo(null)}>отмена</button>
          </p>
        )}
        <textarea className="dash-input" aria-label="Новый комментарий" value={body} onChange={e => setBody(e.target.value)}
          placeholder="Комментарий. Поддерживается Markdown; скриншот можно вставить из буфера (Ctrl+V)"
          onPaste={e => {
            const imgs = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'))
            if (imgs.length) { e.preventDefault(); attach(imgs) }
          }} />
        {pending.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Прикреплённые файлы">
            {pending.map(p => (
              <li key={p.label} className="dash-chip">
                <b>{p.label}</b> {p.file.name}
                <button type="button" className="ml-1" onClick={() => unattach(p.label)} aria-label={`Убрать ${p.label}`}><X className="h-3 w-3" aria-hidden /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select className="dash-input !min-h-8 !w-auto text-xs" aria-label="Упомянуть участника" value=""
              onChange={e => {
                const m = people.find(p => p.user_id === e.target.value)
                if (!m) return
                setMentions(x => ({ ...x, [m.user_id!]: m.name }))
                setBody(b => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${m.name} `)
              }}>
              <option value="">@ Упомянуть…</option>
              {people.map(p => <option key={p.id} value={p.user_id!}>{p.name}</option>)}
            </select>
            <input ref={picker} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Файлы к комментарию" data-testid="comment-file-input"
              onChange={e => { attach(Array.from(e.target.files ?? [])); e.target.value = '' }} />
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => picker.current?.click()}>
              <Paperclip className="h-4 w-4" aria-hidden /> Файлы
            </button>
          </div>
          <button className="dash-btn dash-btn-sm" disabled={add.isPending || (!body.trim() && !pending.length)}>{add.isPending ? 'Отправляем…' : 'Отправить'}</button>
        </div>
      </form>
    </div>
  )
}

/** «Обсудить в чате»: одним щелчком отправляет карточку задачи в выбранный диалог. */
function SendToChat({ taskId, num }: { taskId: string; num: number }) {
  const { workspace, userId, byUser } = useWorkspace()
  const toast = useToast()
  const convs = useQuery({ queryKey: ['conversations', workspace.id], queryFn: () => fetchConversations(workspace.id) })
  const label = (c: { kind: string; name: string | null; direct_key: string | null }) =>
    c.kind === 'direct' ? byUser(c.direct_key?.split(':').find(x => x !== userId))?.name ?? 'Личный диалог' : `${c.kind === 'channel' ? '# ' : ''}${c.name ?? ''}`
  const send = useMutation({
    mutationFn: (convId: string) => sendMessage(convId, `Задача #${num}`, taskId),
    onSuccess: () => toast(`Задача #${num} отправлена в чат`),
    onError: e => toast(errMsg(e), 'error'),
  })
  return (
    <label className="flex items-center gap-2 text-sm">
      <MessageSquarePlus className="h-4 w-4 dash-muted" aria-hidden />
      <select className="dash-input !min-h-9 !w-auto text-sm" value="" aria-label="Отправить задачу в чат"
        onChange={e => e.target.value && send.mutate(e.target.value)}>
        <option value="">Отправить в чат…</option>
        {convs.data?.map(c => <option key={c.id} value={c.id}>{label(c)}</option>)}
      </select>
    </label>
  )
}


function Comment({ c, onReply, refresh }: { c: TaskComment; onReply?: () => void; refresh: () => void }) {
  const { byUser, userId } = useWorkspace()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(c.body)
  const mine = c.author_id === userId && !c.deleted_at
  const author = byUser(c.author_id)

  const save = useMutation({
    mutationFn: () => editComment(c.id, text.trim()),
    onSuccess: () => { setEditing(false); refresh() },
    onError: e => toast(errMsg(e), 'error'),
  })
  const del = useMutation({
    mutationFn: () => deleteComment(c.id),
    onSuccess: refresh,
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <article className="flex gap-3" data-testid="comment">
      <Avatar member={author} size={28} />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <b className="text-sm">{author?.name ?? 'Участник'}</b>
          <time className="dash-muted" dateTime={c.created_at} title={fmtDateTime(c.created_at)}>{timeAgo(c.created_at)}</time>
          {c.edited_at && <span className="dash-muted">(изменено)</span>}
        </header>
        {editing ? (
          <form className="mt-1 space-y-2" onSubmit={e => { e.preventDefault(); if (text.trim()) save.mutate() }}>
            <textarea className="dash-input" aria-label="Текст комментария" value={text} onChange={e => setText(e.target.value)} />
            <div className="flex gap-2">
              <button className="dash-btn dash-btn-sm" disabled={save.isPending}>Сохранить</button>
              <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => { setEditing(false); setText(c.body) }}>Отмена</button>
            </div>
          </form>
        ) : (
          <div className={`mt-0.5 ${c.deleted_at ? 'dash-muted italic' : ''}`}><Md>{c.body}</Md></div>
        )}
        {!editing && !c.deleted_at && (
          <div className="mt-1 flex gap-3 text-xs dash-muted">
            {onReply && <button className="inline-flex items-center gap-1 hover:text-[var(--d-text)]" onClick={onReply}><Reply className="h-3 w-3" aria-hidden />Ответить</button>}
            {mine && <button className="inline-flex items-center gap-1 hover:text-[var(--d-text)]" onClick={() => setEditing(true)}><Pencil className="h-3 w-3" aria-hidden />Изменить</button>}
            {mine && <button className="inline-flex items-center gap-1 hover:text-[var(--d-text)]" onClick={() => confirm('Удалить комментарий?') && del.mutate()}><Trash2 className="h-3 w-3" aria-hidden />Удалить</button>}
          </div>
        )}
      </div>
    </article>
  )
}

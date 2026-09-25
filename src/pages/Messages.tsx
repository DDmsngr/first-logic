import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CircleHelp, ListChecks, Paperclip, UserPlus, Users, X } from 'lucide-react'
import {
  MAX_FILE, addGroupMembers, createGroup, fetchAttachments, fetchConvMembers, fetchConversations, fetchMessages,
  fetchTasks, fetchUnread, markRead, openDirect, sendMessage, uploadFile,
} from '../api'
import { useWorkspace } from '../auth'
import { fmtDateTime } from '../meta'
import type { Conversation, Message, Task } from '../types'
import { Avatar, Field, Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'
import { FileList } from '../shared'
import { StatusChip } from '../taskParts'
import Md from '../Md'

/** Диалоги и их заголовки: канал (#), группа, личный чат (по имени собеседника). */
function useConvLabel() {
  const { userId, byUser } = useWorkspace()
  return (c: Conversation) => {
    if (c.kind === 'direct') return byUser(c.direct_key?.split(':').find(x => x !== userId))?.name ?? 'Личный диалог'
    return c.name ?? (c.kind === 'channel' ? 'Канал' : 'Группа')
  }
}

export default function Messages() {
  const { convId } = useParams()
  const { workspace, members, userId } = useWorkspace()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const label = useConvLabel()
  const [creating, setCreating] = useState(false)

  const convs = useQuery({ queryKey: ['conversations', workspace.id], queryFn: () => fetchConversations(workspace.id) })
  const unread = useQuery({ queryKey: ['unread', workspace.id], queryFn: () => fetchUnread(workspace.id) })

  const others = members.filter(m => m.status === 'active' && m.user_id && m.user_id !== userId)
  // список диалогов надо обновить ДО перехода: иначе новый диалог «не найден» в старом кеше
  const goTo = async (id: string) => {
    await qc.invalidateQueries({ queryKey: ['conversations'] })
    nav(`/messages/${id}`)
  }
  const start = useMutation({
    mutationFn: (uid: string) => openDirect(workspace.id, uid),
    onSuccess: goTo,
    onError: e => toast(errMsg(e), 'error'),
  })
  const active = convs.data?.find(c => c.id === convId)

  const sections: { title: string; items: Conversation[] }[] = [
    { title: 'Каналы', items: convs.data?.filter(c => c.kind === 'channel') ?? [] },
    { title: 'Группы', items: convs.data?.filter(c => c.kind === 'group') ?? [] },
    { title: 'Личные', items: convs.data?.filter(c => c.kind === 'direct') ?? [] },
  ]

  return (
    <>
      <PageHeader title="Сообщения"
        actions={<button className="dash-btn dash-btn-sm" onClick={() => setCreating(true)}><Users className="h-4 w-4" aria-hidden /> Новая группа</button>} />
      <div className="dash-card grid min-h-[60dvh] overflow-hidden md:grid-cols-[260px_1fr]">
        <aside className={`border-[var(--d-line)] md:border-r ${convId ? 'hidden md:block' : ''}`} aria-label="Диалоги">
          <QueryState loading={convs.isLoading} error={convs.error} onRetry={() => convs.refetch()}>
            {sections.filter(s => s.items.length > 0).map(s => (
              <div key={s.title}>
                <h2 className="dash-label px-4 pb-1 pt-3">{s.title}</h2>
                <ul>
                  {s.items.map(c => {
                    const n = unread.data?.[c.id] ?? 0
                    return (
                      <li key={c.id}>
                        <Link to={`/messages/${c.id}`} aria-current={c.id === convId ? 'page' : undefined}
                          className={`flex min-h-11 items-center gap-2 px-4 text-sm hover:bg-[var(--d-raised)] ${c.id === convId ? 'bg-[var(--d-raised)]' : ''}`}>
                          <span className="flex-1 truncate">{c.kind === 'channel' ? '# ' : ''}{label(c)}</span>
                          {n > 0 && <span className="rounded-full bg-[var(--d-tint)] px-1.5 text-[11px] font-bold text-[var(--d-on-accent)]" aria-label={`${n} непрочитанных`}>{n}</span>}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </QueryState>
          {others.length > 0 && (
            <div className="border-t border-[var(--d-line)] p-3">
              <select className="dash-input !min-h-9 text-xs" aria-label="Новый личный диалог" value=""
                onChange={e => e.target.value && start.mutate(e.target.value)}>
                <option value="">+ Написать участнику…</option>
                {others.map(m => <option key={m.id} value={m.user_id!}>{m.name}</option>)}
              </select>
            </div>
          )}
        </aside>

        <section className={convId ? '' : 'hidden md:grid md:place-items-center'} aria-label="Переписка">
          {active ? (
            <Thread conv={active} title={label(active)} />
          ) : convId && convs.isLoading ? null : (
            <p className="dash-muted p-6 text-sm">{convId ? 'Диалог не найден' : 'Выберите диалог слева'}</p>
          )}
        </section>
      </div>
      <GroupModal open={creating} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); void goTo(id) }} />
    </>
  )
}

function GroupModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { workspace, members, userId } = useWorkspace()
  const toast = useToast()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const people = members.filter(m => m.status === 'active' && m.user_id && m.user_id !== userId)
  const create = useMutation({
    mutationFn: () => createGroup(workspace.id, name.trim(), picked),
    onSuccess: id => { setName(''); setPicked([]); onCreated(id) },
    onError: e => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open={open} onClose={onClose} title="Новая группа">
      <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) create.mutate() }}>
        <Field label="Название"><input className="dash-input" required autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Например: Релиз 1.2" /></Field>
        <fieldset>
          <legend className="dash-label mb-1.5">Участники</legend>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {people.length === 0 && <p className="dash-muted text-sm">Пока некого добавить.</p>}
            {people.map(m => (
              <label key={m.id} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-[var(--d-raised)]">
                <input type="checkbox" checked={picked.includes(m.user_id!)}
                  onChange={e => setPicked(p => e.target.checked ? [...p, m.user_id!] : p.filter(x => x !== m.user_id))} />
                <Avatar member={m} size={24} /><span className="text-sm">{m.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex justify-end gap-2">
          <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
          <button className="dash-btn" disabled={create.isPending || !name.trim()}>Создать группу</button>
        </div>
      </form>
    </Modal>
  )
}

const TASK_CMD = /^\/task\s+#?(\d+)(?:\s+([\s\S]*))?$/i

function Thread({ conv, title }: { conv: Conversation; title: string }) {
  const { workspace, project, userId, byUser, members } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [older, setOlder] = useState<Message[]>([])
  const [exhausted, setExhausted] = useState(false)
  const [body, setBody] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [taskRef, setTaskRef] = useState<Task | null>(null)
  const [pickTask, setPickTask] = useState(false)
  const [help, setHelp] = useState(false)
  const [addPeople, setAddPeople] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setOlder([]); setExhausted(false); setTaskRef(null); setPendingFiles([]) }, [conv.id])

  const tasks = useQuery({ queryKey: ['tasks', project.id, { sort: 'priority' }], queryFn: () => fetchTasks(project.id, { sort: 'priority' }) })
  const taskById = useMemo(() => new Map((tasks.data ?? []).map(t => [t.id, t])), [tasks.data])

  const latest = useQuery({ queryKey: ['messages', conv.id], queryFn: () => fetchMessages(conv.id), refetchInterval: 5000 })
  const msgs = [...older, ...(latest.data ?? [])].filter((m, i, a) => a.findIndex(x => x.id === m.id) === i)
  const ids = msgs.map(m => m.id)
  const files = useQuery({
    queryKey: ['attachments', 'messages', conv.id, ids.length],
    queryFn: () => fetchAttachments({ messageIds: ids }),
    enabled: ids.length > 0,
  })

  const groupMembers = useQuery({
    queryKey: ['conv-members', conv.id], queryFn: () => fetchConvMembers(conv.id), enabled: conv.kind === 'group',
  })

  // прочитано: открыли диалог или пришло новое сообщение
  const lastId = latest.data?.[latest.data.length - 1]?.id
  useEffect(() => {
    if (!lastId) return
    void markRead(conv.id).then(() => qc.invalidateQueries({ queryKey: ['unread'] }))
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [lastId, conv.id, qc])

  const loadOlder = async () => {
    try {
      const page = await fetchMessages(conv.id, msgs[0]?.created_at)
      setOlder(o => [...page, ...o])
      if (page.length < 30) setExhausted(true)
    } catch (e) { toast(errMsg(e), 'error') }
  }

  const send = useMutation({
    mutationFn: async () => {
      let text = body.trim()
      let task = taskRef
      const cmd = TASK_CMD.exec(text)
      if (cmd) {
        const found = (tasks.data ?? []).find(t => t.num === Number(cmd[1]))
        if (!found) throw new Error(`Задача #${cmd[1]} не найдена`)
        task = found
        text = (cmd[2] ?? '').trim()
      }
      if (!text) text = task ? `Задача #${task.num}` : pendingFiles.length ? `Файлы: ${pendingFiles.map(f => f.name).join(', ')}` : ''
      if (!text) return
      const m = await sendMessage(conv.id, text, task?.id ?? null)
      for (const f of pendingFiles) {
        try { await uploadFile(workspace.id, userId, f, { messageId: m.id }) }
        catch (e) { toast(`Сообщение отправлено, файл ${f.name} — нет: ${errMsg(e)}`, 'error') }
      }
    },
    onSuccess: () => {
      setBody(''); setPendingFiles([]); setTaskRef(null)
      if (textarea.current) textarea.current.style.height = ''
      qc.invalidateQueries({ queryKey: ['messages'] }); qc.invalidateQueries({ queryKey: ['attachments'] })
    },
    onError: e => toast(errMsg(e), 'error'),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (/^\/help\s*$/i.test(body.trim())) { setBody(''); setHelp(true); return }
    if (body.trim() || taskRef || pendingFiles.length) send.mutate()
  }

  // проверяем размер сразу при выборе файла — иначе о слишком большом скрине
  // узнаёшь только после «Отправить», и на телефоне легко пропустить тост
  const pickFiles = (list: FileList | null) => {
    const picked = Array.from(list ?? [])
    const ok = picked.filter(f => f.size <= MAX_FILE)
    const big = picked.filter(f => f.size > MAX_FILE)
    if (ok.length) setPendingFiles(p => [...p, ...ok])
    if (big.length) toast(`Не прикрепится, больше 25 МБ: ${big.map(f => f.name).join(', ')}`, 'error')
  }

  const memberNames = (groupMembers.data ?? []).map(id => byUser(id)?.name).filter(Boolean).join(', ')

  return (
    <div className="flex h-[72dvh] flex-col md:h-[66dvh]">
      <header className="flex items-center gap-2 border-b border-[var(--d-line)] px-4 py-3">
        <Link to="/messages" className="md:hidden" aria-label="К списку диалогов"><ArrowLeft className="h-5 w-5" aria-hidden /></Link>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{conv.kind === 'channel' ? '# ' : ''}{title}</h2>
          {conv.kind === 'group' && <p className="dash-muted truncate text-xs">{memberNames || 'Участники'}</p>}
        </div>
        {conv.kind === 'group' && (
          <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setAddPeople(true)}><UserPlus className="h-4 w-4" aria-hidden /> Добавить</button>
        )}
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3" data-testid="thread">
        <QueryState loading={latest.isLoading} error={latest.error} onRetry={() => latest.refetch()} empty={msgs.length === 0} emptyText="Сообщений пока нет" emptyHint="Напишите первым. Команды — кнопка «?» внизу.">
          {!exhausted && msgs.length >= 30 && <button className="dash-btn dash-btn-ghost dash-btn-sm mx-auto block" onClick={loadOlder}>Загрузить ранее</button>}
          {msgs.map(m => {
            const mine = m.author_id === userId
            const t = m.task_id ? taskById.get(m.task_id) : undefined
            const mf = (files.data ?? []).filter(f => f.message_id === m.id)
            return (
              <div key={m.id} className={`flex gap-2 ${mine ? 'flex-row-reverse' : ''}`} data-testid="message">
                <Avatar member={byUser(m.author_id)} size={28} />
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-[var(--d-primary)]' : 'bg-[var(--d-raised)]'}`}>
                  <div className="mb-0.5 text-[11px] opacity-70">{byUser(m.author_id)?.name} · {fmtDateTime(m.created_at)}</div>
                  <Md>{m.body}</Md>
                  {m.task_id && (
                    <Link to={`/tasks/${m.task_id}`} className="mt-1.5 flex items-center gap-2 rounded-xl border border-white/15 bg-black/25 px-3 py-2 hover:bg-black/40" data-testid="task-ref">
                      <ListChecks className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{t ? <><b>#{t.num}</b> {t.title}</> : 'Задача (нет доступа или в архиве)'}</span>
                      {t && <StatusChip status={t.status} />}
                    </Link>
                  )}
                  {mf.length > 0 && <div className="mt-1 rounded-lg bg-black/25 px-2"><FileList files={mf} /></div>}
                </div>
              </div>
            )
          })}
          <div ref={bottom} />
        </QueryState>
      </div>

      <form onSubmit={submit} className="dash-safe-bottom border-t border-[var(--d-line)] p-3">
        {(taskRef || pendingFiles.length > 0) && (
          <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Вложения">
            {taskRef && <li className="dash-chip"><ListChecks className="h-3 w-3" aria-hidden /> #{taskRef.num} {taskRef.title.slice(0, 40)}
              <button type="button" className="ml-1" onClick={() => setTaskRef(null)} aria-label="Убрать задачу"><X className="h-3 w-3" aria-hidden /></button></li>}
            {pendingFiles.map((f, i) => <li key={i} className="dash-chip"><Paperclip className="h-3 w-3" aria-hidden /> {f.name}
              <button type="button" className="ml-1" onClick={() => setPendingFiles(p => p.filter((_, j) => j !== i))} aria-label={`Убрать ${f.name}`}><X className="h-3 w-3" aria-hidden /></button></li>)}
          </ul>
        )}
        {/* поле на всю ширину отдельной строкой — иначе на телефоне ему остаётся
            десяток пикселей между четырьмя кнопками-иконками и «Отправить» */}
        <textarea ref={textarea} className="dash-input mb-2 max-h-40 min-h-11 resize-none overflow-y-auto"
          rows={1} aria-label="Сообщение" placeholder="Сообщение… (Markdown, /task 12, /help)" value={body}
          enterKeyHint="send"
          onChange={e => {
            setBody(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
          }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e as unknown as FormEvent) } }} />
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Файлы к сообщению" data-testid="msg-file"
              onChange={e => { pickFiles(e.target.files); e.target.value = '' }} />
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !min-h-11 !w-11 !px-0" onClick={() => fileInput.current?.click()} aria-label="Прикрепить файлы"><Paperclip className="h-4 w-4" aria-hidden /></button>
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !min-h-11 !w-11 !px-0" onClick={() => setPickTask(true)} aria-label="Прикрепить задачу"><ListChecks className="h-4 w-4" aria-hidden /></button>
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !min-h-11 !w-11 !px-0" onClick={() => setHelp(true)} aria-label="Справка по командам и Markdown"><CircleHelp className="h-4 w-4" aria-hidden /></button>
          </div>
          <button className="dash-btn" disabled={send.isPending || (!body.trim() && !taskRef && !pendingFiles.length)}>Отправить</button>
        </div>
      </form>

      <TaskPicker open={pickTask} onClose={() => setPickTask(false)} tasks={tasks.data ?? []} onPick={t => { setTaskRef(t); setPickTask(false) }} />
      <HelpModal open={help} onClose={() => setHelp(false)} />
      {conv.kind === 'group' && (
        <AddPeopleModal open={addPeople} onClose={() => setAddPeople(false)} convId={conv.id}
          already={groupMembers.data ?? []} candidates={members.filter(m => m.status === 'active' && m.user_id)} />
      )}
    </div>
  )
}

function TaskPicker({ open, onClose, tasks, onPick }: { open: boolean; onClose: () => void; tasks: Task[]; onPick: (t: Task) => void }) {
  const [q, setQ] = useState('')
  const list = tasks.filter(t => !q.trim() || t.title.toLowerCase().includes(q.trim().toLowerCase()) || `#${t.num}` === q.trim() || String(t.num) === q.trim().replace('#', '')).slice(0, 30)
  return (
    <Modal open={open} onClose={onClose} title="Прикрепить задачу">
      <input className="dash-input mb-3" type="search" autoFocus placeholder="Номер или название" aria-label="Поиск задачи" value={q} onChange={e => setQ(e.target.value)} />
      <ul className="max-h-72 overflow-y-auto">
        {list.map(t => (
          <li key={t.id}>
            <button type="button" className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-[var(--d-raised)]" onClick={() => onPick(t)}>
              <span className="dash-muted font-mono text-xs">#{t.num}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
              <StatusChip status={t.status} />
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="dash-muted p-3 text-sm">Ничего не найдено</li>}
      </ul>
    </Modal>
  )
}

function AddPeopleModal({ open, onClose, convId, already, candidates }: {
  open: boolean; onClose: () => void; convId: string; already: string[]; candidates: { id: string; user_id: string | null; name: string }[]
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const [picked, setPicked] = useState<string[]>([])
  const free = candidates.filter(c => c.user_id && !already.includes(c.user_id))
  const add = useMutation({
    mutationFn: () => addGroupMembers(convId, picked),
    onSuccess: () => { setPicked([]); qc.invalidateQueries({ queryKey: ['conv-members'] }); onClose() },
    onError: e => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open={open} onClose={onClose} title="Добавить в группу">
      {free.length === 0 ? <p className="dash-muted text-sm">Все участники workspace уже в группе.</p> : (
        <div className="space-y-1">
          {free.map(m => (
            <label key={m.id} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-[var(--d-raised)]">
              <input type="checkbox" checked={picked.includes(m.user_id!)} onChange={e => setPicked(p => e.target.checked ? [...p, m.user_id!] : p.filter(x => x !== m.user_id))} />
              <span className="text-sm">{m.name}</span>
            </label>
          ))}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="dash-btn dash-btn-ghost" onClick={onClose}>Закрыть</button>
        <button className="dash-btn" disabled={!picked.length || add.isPending} onClick={() => add.mutate()}>Добавить</button>
      </div>
    </Modal>
  )
}

function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const row = (cmd: string, text: string) => <tr><td className="whitespace-nowrap py-1.5 pr-4 align-top font-mono text-xs text-[var(--d-tint)]">{cmd}</td><td className="py-1.5 text-sm">{text}</td></tr>
  return (
    <Modal open={open} onClose={onClose} title="Команды и форматирование">
      <h3 className="dash-label mb-1">Команды</h3>
      <table className="mb-4 w-full"><tbody>
        {row('/task 12', 'прикрепить к сообщению карточку задачи #12')}
        {row('/task 12 Глянь, пожалуйста', 'то же, с подписью')}
        {row('/help', 'открыть эту справку')}
      </tbody></table>
      <h3 className="dash-label mb-1">Кнопки под полем ввода</h3>
      <p className="mb-4 text-sm">Скрепка — файлы (можно несколько), значок списка — выбрать задачу из списка одним щелчком. Enter отправляет, Shift+Enter — новая строка.</p>
      <h3 className="dash-label mb-1">Markdown</h3>
      <table className="w-full"><tbody>
        {row('**жирный**', 'жирный текст')}
        {row('_курсив_', 'курсив')}
        {row('`код`', 'моноширинный фрагмент; блок — тремя ` в начале и в конце')}
        {row('- пункт', 'маркированный список (1. — нумерованный)')}
        {row('> цитата', 'цитата')}
        {row('[текст](https://…)', 'ссылка')}
        {row('~~зачёркнуто~~', 'зачёркнутый текст')}
      </tbody></table>
      <p className="dash-muted mt-3 text-xs">Картинки по ссылке в тексте не подгружаются, файлы прикрепляйте скрепкой.</p>
    </Modal>
  )
}

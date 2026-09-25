import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleHelp, Copy, Download, FileDown, FileUp } from 'lucide-react'
import { fetchTasks, importTasks } from './api'
import { useWorkspace } from './auth'
import { PRIORITIES, STATUSES, fmtDate } from './meta'
import { AI_PROMPT, buildExport, buildTemplate, parseTaskFile, type ImportRow } from './taskJson'
import type { Task } from './types'
import { Modal, errMsg, useToast } from './ui'

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const stamp = () => new Date().toISOString().slice(0, 10)

/** Импорт, экспорт и справка: JSON-файл задач. Импорт — только owner/admin (создавать задачи может только он). */
export default function TasksIO({ exportTasks }: { exportTasks: Task[] }) {
  const { members, labels, isAdmin } = useWorkspace()
  const [importing, setImporting] = useState(false)
  const [help, setHelp] = useState(false)

  const doExport = () => {
    const data = buildExport(exportTasks, members, id => labels.find(l => l.id === id)?.name)
    download(`tasks-${stamp()}.json`, data)
  }

  return (
    <>
      {isAdmin && (
        <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setImporting(true)}>
          <FileUp className="h-4 w-4" aria-hidden /> Импорт из JSON
        </button>
      )}
      <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={doExport} disabled={exportTasks.length === 0}
        title="Выгрузит задачи из текущей выборки (учитываются фильтры)">
        <FileDown className="h-4 w-4" aria-hidden /> Экспорт
      </button>
      <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setHelp(true)} aria-label="Как работает импорт и экспорт">
        <CircleHelp className="h-4 w-4" aria-hidden />
      </button>
      {importing && <ImportModal onClose={() => setImporting(false)} onHelp={() => setHelp(true)} />}
      <HelpModal open={help} onClose={() => setHelp(false)} />
    </>
  )
}

function ImportModal({ onClose, onHelp }: { onClose: () => void; onHelp: () => void }) {
  const { project, members } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [text, setText] = useState('')
  const [skipDup, setSkipDup] = useState(true)
  const [done, setDone] = useState<{ num: number; title: string }[] | null>(null)
  const file = useRef<HTMLInputElement>(null)

  // все задачи проекта (не только текущая выборка) — для поиска дубликатов по названию
  const existing = useQuery({ queryKey: ['tasks', project.id, { sort: 'priority' }], queryFn: () => fetchTasks(project.id, { sort: 'priority' }) })
  const parsed = useMemo(
    () => (text.trim() ? parseTaskFile(text, members, (existing.data ?? []).map(t => t.title)) : null),
    [text, members, existing.data],
  )

  const rows = parsed?.rows ?? []
  const toCreate = rows.filter(r => !(skipDup && r.duplicate))
  const errorRows = rows.filter(r => r.errors.length > 0)
  const free = toCreate.filter(r => !r.assigneeId).length

  const run = useMutation({
    mutationFn: () => importTasks(project.id, toCreate.map(r => ({
      title: r.title, description: r.description, status: r.status, priority: r.priority,
      assignee_id: r.assigneeId, due_date: r.due, labels: r.labels,
    }))),
    onSuccess: created => {
      setDone(created)
      for (const k of ['tasks', 'stats', 'activity', 'notifications', 'labels']) qc.invalidateQueries({ queryKey: [k] })
    },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <Modal open onClose={onClose} title="Импорт задач из JSON">
      {done ? (
        <div className="space-y-3">
          <p className="text-sm" role="status">Создано задач: <b>{done.length}</b>. Свободные можно взять на доске или на «Обзоре».</p>
          <ul className="max-h-56 overflow-y-auto text-sm">
            {done.map(t => <li key={t.num} className="dash-row py-1.5"><span className="dash-muted mr-2 font-mono text-xs">#{t.num}</span>{t.title}</li>)}
          </ul>
          <div className="flex justify-end"><button className="dash-btn" onClick={onClose}>Готово</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input ref={file} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-label="Файл JSON" data-testid="import-file"
              onChange={async e => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = '' }} />
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => file.current?.click()}><FileUp className="h-4 w-4" aria-hidden /> Выбрать файл…</button>
            <button type="button" className="dash-muted text-xs underline" onClick={onHelp}>Формат файла</button>
          </div>
          <textarea className="dash-input font-mono text-xs" rows={5} aria-label="Или вставьте JSON сюда" placeholder='…или вставьте JSON сюда: {"tasks": [{"title": "…"}]}'
            value={text} onChange={e => setText(e.target.value)} />

          {parsed?.fatal && <p role="alert" className="text-sm text-[var(--d-tint)]">{parsed.fatal}</p>}

          {rows.length > 0 && (
            <>
              <ul className="max-h-64 overflow-y-auto rounded-xl border border-[var(--d-line)]" aria-label="Предпросмотр" data-testid="import-preview">
                {rows.map(r => <PreviewRow key={r.index} r={r} skipped={skipDup && r.duplicate} />)}
              </ul>
              {rows.some(r => r.duplicate) && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={skipDup} onChange={e => setSkipDup(e.target.checked)} />
                  Пропустить задачи, которые уже есть (по названию)
                </label>
              )}
              {errorRows.length > 0
                ? <p role="alert" className="text-sm text-[var(--d-tint)]">Есть ошибки в {errorRows.length} задачах — исправьте файл. Пока они есть, импорт заблокирован, чтобы не создать половину.</p>
                : <p className="dash-muted text-sm" data-testid="import-summary">Будет создано: <b className="text-[var(--d-text)]">{toCreate.length}</b>, из них свободных: {free}, назначенных: {toCreate.length - free}.</p>}
            </>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
            <button className="dash-btn" disabled={run.isPending || !!parsed?.fatal || errorRows.length > 0 || toCreate.length === 0} onClick={() => run.mutate()}>
              {run.isPending ? 'Создаём…' : `Создать ${toCreate.length || ''} задач`.replace('  ', ' ')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function PreviewRow({ r, skipped }: { r: ImportRow; skipped: boolean }) {
  const st = STATUSES.find(s => s.id === r.status)!
  const pr = PRIORITIES.find(p => p.id === r.priority)!
  const bad = r.errors.length > 0
  return (
    <li className={`dash-row px-3 py-2 text-sm ${skipped ? 'opacity-50' : ''}`} data-testid="import-row">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="dash-muted font-mono text-xs">{r.index}.</span>
        <span className={`min-w-0 flex-1 font-medium ${bad ? 'text-[var(--d-tint)]' : ''}`}>{r.title || '(без названия)'}</span>
        {skipped && <span className="dash-chip">уже есть — пропуск</span>}
      </div>
      {!bad && (
        <div className="dash-muted mt-0.5 text-xs">
          {st.label} · {pr.label} · {r.assigneeName ? <b className="text-[var(--d-text)]">{r.assigneeName}</b> : 'свободная'}
          {r.due && ` · до ${fmtDate(r.due)}`}{r.labels.length > 0 && ` · ${r.labels.join(', ')}`}
        </div>
      )}
      {r.errors.map((e, i) => <div key={i} className="mt-0.5 text-xs text-[var(--d-tint)]">⚠ {e}</div>)}
      {r.warnings.map((w, i) => <div key={i} className="dash-muted mt-0.5 text-xs">{w}</div>)}
    </li>
  )
}

function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { members, isAdmin } = useWorkspace()
  const toast = useToast()
  const first = members.find(m => m.status === 'active')?.email ?? null
  const cell = 'py-1.5 pr-3 align-top text-sm'
  return (
    <Modal open={open} onClose={onClose} title="Импорт и экспорт задач (JSON)">
      <div className="space-y-4 text-sm">
        <p>
          Задачи можно загрузить пачкой из JSON-файла: описали список — загрузили — все задачи созданы и разложены.
          {isAdmin ? '' : ' Загружать файлы могут owner и admin, выгружать — все.'}
        </p>

        <section>
          <h3 className="dash-label mb-1">Как раздаются задачи</h3>
          <ul className="list-disc space-y-1 pl-5">
            <li><b>Без исполнителя</b> (поле <code>assignee</code> не указано или <code>null</code>) — свободная задача: её увидят на «Обзоре» и на доске, кто хочет — нажимает «Взять», и она закрепляется за ним.</li>
            <li><b>С исполнителем</b> (<code>"assignee": "Алексей"</code>) — сразу уходит этому человеку, он получит уведомление.</li>
          </ul>
        </section>

        <section>
          <h3 className="dash-label mb-1">Пример</h3>
          <pre className="dash-md overflow-x-auto rounded-lg bg-black/35 p-3 text-xs"><code>{JSON.stringify(buildTemplate(first), null, 2)}</code></pre>
        </section>

        <section>
          <h3 className="dash-label mb-1">Поля задачи</h3>
          <table className="w-full"><tbody>
            <tr><td className={`${cell} font-mono text-xs text-[var(--d-tint)]`}>title</td><td className={cell}><b>обязательно.</b> Название, до 200 символов.</td></tr>
            <tr><td className={`${cell} font-mono text-xs text-[var(--d-tint)]`}>description</td><td className={cell}>Описание, можно Markdown.</td></tr>
            <tr><td className={`${cell} font-mono text-xs text-[var(--d-tint)]`}>priority</td><td className={cell}><code>low</code>, <code>medium</code> (по умолчанию), <code>high</code>, <code>critical</code>.</td></tr>
            <tr><td className={`${cell} font-mono text-xs text-[var(--d-tint)]`}>status</td><td className={cell}><code>backlog</code>, <code>todo</code> (по умолчанию), <code>in_progress</code>, <code>review</code>, <code>blocked</code>, <code>done</code>.</td></tr>
            <tr><td className={`${cell} font-mono text-xs text-[var(--d-tint)]`}>assignee</td><td className={cell}>Email или имя участника (достаточно уникальной части: «Иван»). Если подходят двое — укажите email.</td></tr>
            <tr><td className={`${cell} font-mono text-xs text-[var(--d-tint)]`}>due</td><td className={cell}>Срок, формат <code>ГГГГ-ММ-ДД</code>.</td></tr>
            <tr><td className={`${cell} font-mono text-xs text-[var(--d-tint)]`}>labels</td><td className={cell}>Список меток; нет такой — создастся.</td></tr>
          </tbody></table>
        </section>

        <section>
          <h3 className="dash-label mb-1">Важно</h3>
          <ul className="list-disc space-y-1 pl-5">
            <li>Перед созданием показывается предпросмотр: кому что уйдёт, какие ошибки. Есть ошибки — импорт заблокирован, создаётся <b>всё или ничего</b>.</li>
            <li>Импорт всегда <b>создаёт новые</b> задачи, существующие не меняет. Задачи с уже имеющимся названием можно пропустить галочкой.</li>
            <li>За раз — не больше 200 задач. Номера <code>#N</code> присваиваются автоматически.</li>
            <li><b>Экспорт</b> выгружает задачи из текущей выборки (с учётом фильтров) в этом же формате.</li>
          </ul>
        </section>

        <section>
          <h3 className="dash-label mb-1">Составить файл с помощью ИИ</h3>
          <p className="mb-2">Скопируйте описание формата, отдайте его ассистенту вместе со списком задач словами — он вернёт готовый файл.</p>
          <div className="flex flex-wrap gap-2">
            <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => { void navigator.clipboard?.writeText(AI_PROMPT); toast('Описание формата скопировано') }}><Copy className="h-4 w-4" aria-hidden /> Скопировать для ИИ</button>
            <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => download('tasks-example.json', buildTemplate(first))}><Download className="h-4 w-4" aria-hidden /> Скачать пример</button>
          </div>
        </section>
      </div>
    </Modal>
  )
}

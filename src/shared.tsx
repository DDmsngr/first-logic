import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, FileText, Trash2, Upload } from 'lucide-react'
import {
  PAGE, deleteAttachment, fetchActivity, fileLabels, isImage, signedUrl, updateAttachment, uploadFile, type UploadTarget,
} from './api'
import { useWorkspace } from './auth'
import { DOC_TYPES, describeActivity, fmtDateTime, fmtSize, timeAgo } from './meta'
import type { ActivityEvent, Attachment, DocType } from './types'
import { Modal, QueryState, Spinner, errMsg, useToast } from './ui'

// ── журнал активности ───────────────────────────────────────────────────────

/** Куда ведёт запись журнала: карточка того, что изменилось. */
function activityLink(e: ActivityEvent): string | null {
  const id = e.entity_id
  switch (e.entity_type) {
    case 'task': return id && `/tasks/${id}`
    case 'component': return id && `/components/${id}`
    case 'product': return id && `/products/${id}`
    case 'assembly': return id && `/assemblies/${id}`
    case 'order': return id && `/orders/${id}`
    case 'stocktake': return id && `/stocktake/${id}`
    case 'sale': return id && `/sales/${id}`
    case 'supplier': return id && `/suppliers/${id}`
    case 'expense': return '/finance'
    case 'member': return e.action === 'member.joined' && e.actor_id ? `/team/${e.actor_id}` : '/team'
    default: return null
  }
}

// на карточке самой сущности ссылка вела бы на эту же страницу — там строки просто текст
function ActivityRow({ to, children }: { to: string | null; children: React.ReactNode }) {
  return to
    ? <Link to={to} className="-mx-2 flex gap-3 rounded-md px-2 py-1 hover:bg-white/5 active:bg-white/10">{children}</Link>
    : <div className="flex gap-3 py-1">{children}</div>
}

export function ActivityList({ entityId, actorId, empty = 'Событий пока нет' }: {
  entityId?: string; actorId?: string; empty?: string
}) {
  const { workspace, byUser } = useWorkspace()
  const q = useInfiniteQuery({
    queryKey: ['activity', workspace.id, entityId ?? null, actorId ?? null],
    queryFn: ({ pageParam }) => fetchActivity(workspace.id, pageParam, { entityId, actorId }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length : undefined),
  })
  const events = q.data?.pages.flat() ?? []
  return (
    <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty={events.length === 0} emptyText={empty}>
      <ol className="space-y-1" data-testid="activity">
        {events.map(e => (
          <li key={e.id} className="text-sm">
            <ActivityRow to={entityId ? null : activityLink(e)}>
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--d-tint)]" aria-hidden />
              <div className="min-w-0">
                <p>{describeActivity(e, byUser)}</p>
                <time className="dash-muted text-xs" dateTime={e.created_at} title={fmtDateTime(e.created_at)}>{timeAgo(e.created_at)}</time>
              </div>
            </ActivityRow>
          </li>
        ))}
      </ol>
      {q.hasNextPage && (
        <button className="dash-btn dash-btn-ghost dash-btn-sm mt-3" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          {q.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
        </button>
      )}
    </QueryState>
  )
}

// ── загрузка ────────────────────────────────────────────────────────────────

const REFRESH_KEYS = ['attachments', 'tasks', 'task', 'activity', 'notifications']

/** Кнопка загрузки: можно выбрать сразу несколько файлов. */
export function UploadButton({ target, label = 'Прикрепить файлы', onDone, docType, disabled }: {
  target: UploadTarget; label?: string; onDone?: () => void; docType?: DocType; disabled?: boolean
}) {
  const { workspace, userId } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const up = useMutation({
    mutationFn: async (files: File[]) => {
      const failed: string[] = []
      for (const f of files) {
        try { await uploadFile(workspace.id, userId, f, target, docType) }
        catch (e) { failed.push(`${f.name}: ${errMsg(e)}`) }
      }
      if (failed.length) throw new Error(failed.join('; '))
      return files.length
    },
    onSuccess: n => { toast(n === 1 ? 'Файл загружен' : `Загружено файлов: ${n}`); onDone?.() },
    onError: e => toast(errMsg(e), 'error'),
    onSettled: () => REFRESH_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] })),
  })
  return (
    <>
      <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} aria-label={label} data-testid="file-input"
        onChange={e => { const fs = Array.from(e.target.files ?? []); if (fs.length) up.mutate(fs); e.target.value = '' }} />
      <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" disabled={up.isPending || disabled} onClick={() => input.current?.click()}>
        {up.isPending ? <Spinner label="Загружаем" /> : <><Upload className="h-4 w-4" aria-hidden /> {label}</>}
      </button>
    </>
  )
}

// ── превью ──────────────────────────────────────────────────────────────────

/** Ссылка на картинку живёт час; кеш чуть меньше, чтобы не отдавать протухшую. */
function useImageUrl(a: Attachment, enabled = true) {
  return useQuery({
    queryKey: ['img-url', a.id],
    queryFn: () => signedUrl(a.storage_path, undefined, 3600),
    enabled, staleTime: 50 * 60_000, gcTime: 55 * 60_000, refetchInterval: false,
  })
}

export function Thumb({ file, size = 48 }: { file: Attachment; size?: number }) {
  const img = isImage(file)
  const url = useImageUrl(file, img)
  const box = { width: size, height: size }
  if (!img) {
    return <span className="grid shrink-0 place-items-center rounded-lg border border-[var(--d-line)] bg-[var(--d-bg)]" style={box}><FileText className="h-5 w-5 dash-muted" aria-hidden /></span>
  }
  return url.data
    ? <img src={url.data} alt="" loading="lazy" className="shrink-0 rounded-lg border border-[var(--d-line)] object-cover" style={box} />
    : <span className="shrink-0 rounded-lg border border-[var(--d-line)] bg-[var(--d-bg)]" style={box} aria-hidden />
}

export function ImagePreview({ file, onClose }: { file: Attachment | null; onClose: () => void }) {
  const url = useImageUrl(file ?? ({ id: '', storage_path: '' } as Attachment), !!file)
  return (
    <Modal open={!!file} onClose={onClose} title={file?.filename ?? ''}>
      {url.data
        ? <img src={url.data} alt={file?.filename} className="mx-auto max-h-[70dvh] max-w-full rounded-lg object-contain" />
        : <div className="py-10 text-center"><Spinner /></div>}
    </Modal>
  )
}

// ── список файлов ───────────────────────────────────────────────────────────

export function FileList({ files, showTask, labelsFrom, linkOf }: {
  files: Attachment[]; showTask?: boolean
  /** своя подпись привязки (страница документов) */
  linkOf?: (a: Attachment) => React.ReactNode
  /** по каким файлам считать подписи скрин-N (по умолчанию — по самому списку) */
  labelsFrom?: Attachment[]
}) {
  const { byUser, isAdmin, userId } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<Attachment | null>(null)
  const labels = fileLabels(labelsFrom ?? files)

  const open = async (a: Attachment, download: boolean) => {
    setBusy(a.id)
    try {
      const url = await signedUrl(a.storage_path, download ? a.filename : undefined)
      window.open(url, '_blank', 'noopener')
    } catch (e) { toast(errMsg(e), 'error') }
    setBusy(null)
  }
  const setType = useMutation({
    mutationFn: ({ id, doc_type }: { id: string; doc_type: DocType }) => updateAttachment(id, { doc_type }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attachments'] }),
    onError: e => toast(errMsg(e), 'error'),
  })
  const del = useMutation({
    mutationFn: deleteAttachment,
    onSuccess: () => { toast('Файл удалён'); qc.invalidateQueries({ queryKey: ['attachments'] }); qc.invalidateQueries({ queryKey: ['tasks'] }) },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <>
      <ul data-testid="files">
        {files.map(a => (
          <li key={a.id} className="dash-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
            {isImage(a)
              ? <button type="button" onClick={() => setPreview(a)} aria-label={`Просмотр ${a.filename}`}><Thumb file={a} /></button>
              : <Thumb file={a} />}
            <div className="min-w-0 flex-1 basis-40">
              <div className="truncate text-sm font-medium">
                <Link to={`/files/${a.id}`} className="hover:underline">{a.filename}</Link>
                {labels.get(a.id) && a.task_id && <span className="dash-chip ml-2 !py-0 align-middle">{labels.get(a.id)}</span>}
              </div>
              {a.description && <div className="text-xs">{a.description}</div>}
              <div className="dash-muted text-xs">
                {fmtSize(a.size)} · {byUser(a.uploader_id)?.name ?? '—'} · {fmtDateTime(a.created_at)}
                {linkOf && linkOf(a) && <> · {linkOf(a)}</>}
                {showTask && a.task_id && <> · <Link className="underline" to={`/tasks/${a.task_id}`}>задача</Link></>}
                {showTask && a.component_id && <> · <Link className="underline" to={`/components/${a.component_id}`}>компонент</Link></>}
                {showTask && a.product_id && <> · <Link className="underline" to={`/products/${a.product_id}`}>изделие</Link></>}
                {showTask && a.assembly_id && <> · <Link className="underline" to={`/assemblies/${a.assembly_id}`}>узел</Link></>}
                {showTask && a.supplier_id && <> · <Link className="underline" to={`/suppliers/${a.supplier_id}`}>поставщик</Link></>}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <select className="dash-input !min-h-8 !w-auto !py-0 !pl-2 !pr-7 text-xs" aria-label={`Вид документа «${a.filename}»`}
                value={a.doc_type} onChange={e => setType.mutate({ id: a.id, doc_type: e.target.value as DocType })}>
                {DOC_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={busy === a.id} onClick={() => open(a, false)} aria-label={`Открыть ${a.filename}`}>
                <ExternalLink className="h-4 w-4" aria-hidden />
              </button>
              <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={busy === a.id} onClick={() => open(a, true)} aria-label={`Скачать ${a.filename}`}>
                <Download className="h-4 w-4" aria-hidden />
              </button>
              {(isAdmin || a.uploader_id === userId) && (
                <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => confirm(`Удалить «${a.filename}»?`) && del.mutate(a)} aria-label={`Удалить ${a.filename}`}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <ImagePreview file={preview} onClose={() => setPreview(null)} />
    </>
  )
}

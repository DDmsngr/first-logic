import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Download } from 'lucide-react'
import { fetchAttachment, isImage, signedUrl, updateAttachment } from '../api'
import { DOC_TYPES, fmtDateTime, fmtSize } from '../meta'
import type { DocType } from '../types'
import { useWorkspace } from '../auth'
import { QueryState, errMsg, useToast } from '../ui'

/** Постоянная ссылка на файл (её вставляют в текст комментариев): подписанный URL выпускается на месте. */
export default function FilePage() {
  const { id = '' } = useParams()
  const { byUser } = useWorkspace()
  const file = useQuery({ queryKey: ['attachment', id], queryFn: () => fetchAttachment(id) })
  const f = file.data
  const url = useQuery({
    queryKey: ['img-url', id], queryFn: () => signedUrl(f!.storage_path, undefined, 3600),
    enabled: !!f, staleTime: 50 * 60_000, refetchInterval: false,
  })
  const dl = useQuery({
    queryKey: ['dl-url', id], queryFn: () => signedUrl(f!.storage_path, f!.filename, 3600),
    enabled: !!f, staleTime: 50 * 60_000, refetchInterval: false,
  })

  return (
    <div className="mx-auto max-w-4xl">
      <Link to={f?.task_id ? `/tasks/${f.task_id}` : '/files'} className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]">
        <ArrowLeft className="h-4 w-4" aria-hidden /> {f?.task_id ? 'К задаче' : 'К документам'}
      </Link>
      <QueryState loading={file.isLoading} error={file.error} onRetry={() => file.refetch()} empty={!f} emptyText="Файл не найден" emptyHint="Он удалён или у вас нет доступа.">
        {f && (
          <>
            <h1 className="break-all text-xl font-semibold">{f.filename}</h1>
            <p className="dash-muted mt-1 text-sm">{fmtSize(f.size)} · {byUser(f.uploader_id)?.name ?? '—'} · {fmtDateTime(f.created_at)}</p>
            <DocMeta id={f.id} docType={f.doc_type} description={f.description} />
            <div className="dash-card mt-4 p-3">
              {isImage(f) && url.data
                ? <img src={url.data} alt={f.filename} className="mx-auto max-h-[75dvh] max-w-full rounded-lg object-contain" />
                : <p className="dash-muted p-6 text-center text-sm">{isImage(f) ? 'Готовим просмотр…' : 'Для этого типа файла предпросмотра нет.'}</p>}
            </div>
            {dl.data && <a className="dash-btn mt-4" href={dl.data}><Download className="h-4 w-4" aria-hidden /> Скачать</a>}
          </>
        )}
      </QueryState>
    </div>
  )
}

function DocMeta({ id, docType, description }: { id: string; docType: DocType; description: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [desc, setDesc] = useState(description)
  const save = useMutation({
    mutationFn: (patch: { doc_type?: DocType; description?: string }) => updateAttachment(id, patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['attachment', id] }); qc.invalidateQueries({ queryKey: ['attachments'] }); toast('Сохранено') },
    onError: e => toast(errMsg(e), 'error'),
  })
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-[14rem_1fr]">
      <select className="dash-input" aria-label="Вид документа" value={docType} onChange={e => save.mutate({ doc_type: e.target.value as DocType })}>
        {DOC_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <input className="dash-input" placeholder="Описание: ревизия, что внутри, откуда" maxLength={500} value={desc} aria-label="Описание документа"
        onChange={e => setDesc(e.target.value)} onBlur={() => desc !== description && save.mutate({ description: desc.trim() })} />
    </div>
  )
}

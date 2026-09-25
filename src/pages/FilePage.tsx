import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Download } from 'lucide-react'
import { fetchAttachment, isImage, signedUrl } from '../api'
import { fmtDateTime, fmtSize } from '../meta'
import { useWorkspace } from '../auth'
import { QueryState } from '../ui'

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
        <ArrowLeft className="h-4 w-4" aria-hidden /> {f?.task_id ? 'К задаче' : 'К файлам'}
      </Link>
      <QueryState loading={file.isLoading} error={file.error} onRetry={() => file.refetch()} empty={!f} emptyText="Файл не найден" emptyHint="Он удалён или у вас нет доступа.">
        {f && (
          <>
            <h1 className="break-all text-xl font-semibold">{f.filename}</h1>
            <p className="dash-muted mt-1 text-sm">{fmtSize(f.size)} · {byUser(f.uploader_id)?.name ?? '—'} · {fmtDateTime(f.created_at)}</p>
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

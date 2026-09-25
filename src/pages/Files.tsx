import { useEffect, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { PAGE, fetchAttachments } from '../api'
import { useWorkspace } from '../auth'
import { PageHeader, QueryState } from '../ui'
import { FileList } from '../shared'

export default function Files() {
  const { workspace } = useWorkspace()
  const [draft, setDraft] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => { const t = setTimeout(() => setQ(draft), 300); return () => clearTimeout(t) }, [draft])

  const files = useInfiniteQuery({
    queryKey: ['attachments', 'all', workspace.id, q],
    queryFn: ({ pageParam }) => fetchAttachments({ workspaceId: workspace.id, page: pageParam, q }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length : undefined),
  })
  const list = files.data?.pages.flat() ?? []

  return (
    <>
      <PageHeader title="Файлы" sub="Все файлы из задач и сообщений. Загрузить можно внутри задачи или чата." />
      <input className="dash-input mb-4 max-w-md" type="search" placeholder="Поиск по имени файла" aria-label="Поиск по имени файла" value={draft} onChange={e => setDraft(e.target.value)} />
      <div className="dash-card px-4 py-1">
        <QueryState loading={files.isLoading} error={files.error} onRetry={() => files.refetch()} empty={list.length === 0}
          emptyText={q ? 'Такого файла нет' : 'Файлов пока нет'}>
          <FileList files={list} showTask />
        </QueryState>
      </div>
      {files.hasNextPage && (
        <button className="dash-btn dash-btn-ghost dash-btn-sm mt-3" disabled={files.isFetchingNextPage} onClick={() => files.fetchNextPage()}>Показать ещё</button>
      )}
    </>
  )
}

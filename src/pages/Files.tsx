import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { PAGE, attachmentKind, fetchAttachments, fetchTasks, type AttachmentKind } from '../api'
import { useWorkspace } from '../auth'
import { fetchAllComponents } from '../catalog'
import { useAssemblies, useProducts, useSuppliers } from '../catalogParts'
import { useExpenses } from '../financeParts'
import { DOC_TYPES } from '../meta'
import type { Attachment, DocType } from '../types'
import { Field, Modal, PageHeader, QueryState } from '../ui'
import { FileList, UploadButton } from '../shared'

const KINDS: { id: AttachmentKind; label: string; path: string }[] = [
  { id: 'product', label: 'Изделие', path: '/products/' },
  { id: 'assembly', label: 'Узел', path: '/assemblies/' },
  { id: 'component', label: 'Компонент', path: '/components/' },
  { id: 'supplier', label: 'Поставщик', path: '/suppliers/' },
  { id: 'task', label: 'Задача', path: '/tasks/' },
  { id: 'expense', label: 'Расход', path: '/finance?period=all&e=' },
  { id: 'message', label: 'Сообщение', path: '/messages' },
]

/** Имена всего, к чему может быть привязан документ: для подписей и выбора при загрузке. */
function useTargets() {
  const { workspace, project } = useWorkspace()
  const products = useProducts()
  const assemblies = useAssemblies()
  const suppliers = useSuppliers()
  const components = useQuery({ queryKey: ['components', workspace.id, 'all'], queryFn: () => fetchAllComponents(workspace.id) })
  const tasks = useQuery({ queryKey: ['tasks', project.id, { sort: 'priority' }], queryFn: () => fetchTasks(project.id, { sort: 'priority' }) })
  const expenses = useExpenses()
  return useMemo(() => ({
    product: (products.data ?? []).map(x => ({ id: x.id, name: `${x.name}${x.version ? ` ${x.version}` : ''}` })),
    assembly: (assemblies.data ?? []).map(x => ({ id: x.id, name: x.name })),
    component: (components.data ?? []).map(x => ({ id: x.id, name: x.name })),
    supplier: (suppliers.data ?? []).map(x => ({ id: x.id, name: x.name })),
    task: (tasks.data ?? []).map(x => ({ id: x.id, name: `#${x.num} ${x.title}` })),
    expense: (expenses.data ?? []).map(x => ({ id: x.id, name: x.description })),
    message: [] as { id: string; name: string }[],
  }), [products.data, assemblies.data, components.data, suppliers.data, tasks.data, expenses.data])
}

export default function Files() {
  const { workspace } = useWorkspace()
  const [sp, setSp] = useSearchParams()
  const [draft, setDraft] = useState(sp.get('q') ?? '')
  const [uploading, setUploading] = useState(false)
  const type = (sp.get('type') as DocType) || undefined
  const kind = (sp.get('kind') as AttachmentKind) || undefined
  const q = sp.get('q') ?? ''
  const setParam = (k: string, v: string) => setSp(prev => {
    const n = new URLSearchParams(prev)
    if (v) n.set(k, v); else n.delete(k)
    return n
  }, { replace: true })
  useEffect(() => { const t = setTimeout(() => { if (draft !== q) setParam('q', draft) }, 300); return () => clearTimeout(t) }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps

  const targets = useTargets()
  const files = useInfiniteQuery({
    queryKey: ['attachments', 'all', workspace.id, q, type, kind],
    queryFn: ({ pageParam }) => fetchAttachments({ workspaceId: workspace.id, page: pageParam, q, docType: type, kind }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length : undefined),
  })
  const list = files.data?.pages.flat() ?? []

  const linkOf = (a: Attachment) => {
    const t = attachmentKind(a)
    if (!t) return null
    const k = KINDS.find(x => x.id === t.kind)!
    const name = targets[t.kind].find(x => x.id === t.id)?.name
    const href = t.kind === 'message' ? '/messages' : t.kind === 'expense' ? '/finance?period=all' : k.path + t.id
    return <><span className="dash-muted">{k.label}:</span> <Link className="underline" to={href}>{name ?? 'открыть'}</Link></>
  }

  return (
    <>
      <PageHeader title="Документы" sub="Все файлы проекта: чертежи, datasheet, фото, инструкции, счета. Вид определяется при загрузке, его можно поменять."
        actions={<button className="dash-btn" onClick={() => setUploading(true)}><Upload className="h-4 w-4" aria-hidden /> Добавить документ</button>} />

      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-[2fr_1fr_1fr]">
        <input className="dash-input col-span-2 md:col-span-1" type="search" placeholder="Поиск по имени файла" aria-label="Поиск по имени файла" value={draft} onChange={e => setDraft(e.target.value)} />
        <select className="dash-input" value={type ?? ''} onChange={e => setParam('type', e.target.value)} aria-label="Вид документа">
          <option value="">Все виды</option>
          {DOC_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <select className="dash-input" value={kind ?? ''} onChange={e => setParam('kind', e.target.value)} aria-label="К чему привязан">
          <option value="">Привязка: любая</option>
          {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
      </div>

      <div className="dash-card px-4 py-1">
        <QueryState loading={files.isLoading} error={files.error} onRetry={() => files.refetch()} empty={list.length === 0}
          emptyText={q || type || kind ? 'Под фильтры ничего не подходит' : 'Документов пока нет'}
          emptyHint={q || type || kind ? undefined : 'Добавьте кнопкой сверху или прикрепите в карточке изделия, узла, компонента'}>
          <FileList files={list} linkOf={linkOf} />
        </QueryState>
      </div>
      {files.hasNextPage && (
        <button className="dash-btn dash-btn-ghost dash-btn-sm mt-3" disabled={files.isFetchingNextPage} onClick={() => files.fetchNextPage()}>Показать ещё</button>
      )}

      <UploadModal open={uploading} onClose={() => setUploading(false)} targets={targets} />
    </>
  )
}

function UploadModal({ open, onClose, targets }: { open: boolean; onClose: () => void; targets: ReturnType<typeof useTargets> }) {
  const [kind, setKind] = useState<Exclude<AttachmentKind, 'message'>>('product')
  const [id, setId] = useState('')
  const [docType, setDocType] = useState<DocType | ''>('')
  const options = targets[kind]
  const target = id ? { [`${kind}Id`]: id } : null

  return (
    <Modal open={open} onClose={onClose} title="Добавить документ">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="К чему относится">
            <select className="dash-input" value={kind} onChange={e => { setKind(e.target.value as typeof kind); setId('') }}>
              {KINDS.filter(k => k.id !== 'message').map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </Field>
          <Field label="Вид документа" hint="Пусто — определится по файлу">
            <select className="dash-input" value={docType} onChange={e => setDocType(e.target.value as DocType | '')}>
              <option value="">Определить автоматически</option>
              {DOC_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label={KINDS.find(k => k.id === kind)!.label}>
          <select className="dash-input" value={id} onChange={e => setId(e.target.value)}>
            <option value="">Выберите…</option>
            {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </Field>
        {options.length === 0 && <p className="dash-muted text-xs">Здесь пока пусто — сначала создайте запись.</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Готово</button>
          <UploadButton target={target ?? {}} disabled={!target} docType={docType || undefined} label="Выбрать файлы" />
        </div>
      </div>
    </Modal>
  )
}

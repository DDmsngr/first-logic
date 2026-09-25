import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react'
import { deleteSupplier, fetchComponents, fetchSupplier, updateSupplier, type SupplierInput } from '../catalog'
import { fetchAttachments } from '../api'
import { useWorkspace } from '../auth'
import { Price, Stock, SupplierForm } from '../catalogParts'
import { ActivityList, FileList, UploadButton } from '../shared'
import { PageHeader, QueryState, errMsg, useToast } from '../ui'

/** Ссылка на Telegram из «@name», «name» или полного адреса. */
const tgHref = (v: string) => (/^https?:\/\//.test(v) ? v : `https://t.me/${v.replace(/^@/, '')}`)

export default function SupplierDetail() {
  const { id = '' } = useParams()
  const { workspace } = useWorkspace()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState(false)

  const q = useQuery({ queryKey: ['supplier', id], queryFn: () => fetchSupplier(id) })
  const comps = useQuery({ queryKey: ['components', workspace.id, { supplier: id }], queryFn: () => fetchComponents(workspace.id, { supplierId: id }) })
  const files = useQuery({ queryKey: ['attachments', 'supplier', id], queryFn: () => fetchAttachments({ supplierId: id }) })

  const save = useMutation({
    mutationFn: (patch: SupplierInput) => updateSupplier(id, patch),
    onSuccess: () => { setEditing(false); toast('Сохранено'); qc.invalidateQueries({ queryKey: ['supplier', id] }); qc.invalidateQueries({ queryKey: ['suppliers'] }) },
    onError: e => toast(errMsg(e), 'error'),
  })
  const del = useMutation({
    mutationFn: () => deleteSupplier(id),
    onSuccess: () => { toast('Поставщик удалён'); qc.invalidateQueries({ queryKey: ['suppliers'] }); qc.invalidateQueries({ queryKey: ['components'] }); nav('/suppliers') },
    onError: e => toast(errMsg(e), 'error'),
  })

  const s = q.data
  if (!s) return <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty emptyText="Поставщик не найден"><></></QueryState>

  const rows: [string, React.ReactNode][] = [
    ['Контакт', s.contact],
    ['Телефон', s.phone && <a className="hover:underline" href={`tel:${s.phone.replace(/[^\d+]/g, '')}`}>{s.phone}</a>],
    ['Telegram', s.telegram && <a className="text-[var(--d-accent)] hover:underline" href={tgHref(s.telegram)} target="_blank" rel="noopener noreferrer">{s.telegram}</a>],
    ['Email', s.email && <a className="hover:underline" href={`mailto:${s.email}`}>{s.email}</a>],
    ['Сайт', s.website && <a className="text-[var(--d-accent)] hover:underline" href={s.website} target="_blank" rel="noopener noreferrer">{s.website.replace(/^https?:\/\//, '')}</a>],
  ]
  const list = comps.data ?? []

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/suppliers" className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> Поставщики</Link>
      <PageHeader title={s.name} sub={`${list.length} компонентов`}
        actions={!editing && <button className="dash-btn dash-btn-ghost" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" aria-hidden /> Редактировать</button>} />

      {editing ? (
        <section className="dash-card mb-4 p-5" aria-label="Редактирование">
          <SupplierForm initial={s} submitLabel="Сохранить" busy={save.isPending} onSubmit={p => save.mutate(p)} onCancel={() => setEditing(false)} />
        </section>
      ) : (
        <section className="dash-card mb-4 grid gap-4 p-4 md:grid-cols-2" aria-label="Контакты">
          <dl className="space-y-1.5 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="flex gap-2"><dt className="dash-muted w-20 shrink-0">{k}</dt><dd className="min-w-0 break-words">{v || '—'}</dd></div>
            ))}
          </dl>
          <div>
            <h2 className="dash-label mb-1.5">Заметки</h2>
            <p className="whitespace-pre-wrap text-sm">{s.notes || <span className="dash-muted">—</span>}</p>
          </div>
        </section>
      )}

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Компоненты поставщика">
        <h2 className="dash-label mb-2">Компоненты · {list.length}</h2>
        <QueryState loading={comps.isLoading} error={comps.error} onRetry={() => comps.refetch()} empty={list.length === 0}
          emptyText="Компонентов с этим поставщиком нет" emptyHint="Поставщик выбирается в карточке компонента">
          <ul>
            {list.map(c => (
              <li key={c.id} className="dash-row flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
                <Link to={`/components/${c.id}`} className="min-w-0 flex-1 basis-48 truncate font-medium hover:underline">{c.name}</Link>
                <Price amount={c.price} currency={c.currency} per={c.unit} className="text-right" />
                <span className="w-24 text-right"><Stock c={c} /></span>
              </li>
            ))}
          </ul>
        </QueryState>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="dash-card min-w-0 p-4" aria-label="Документы">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="dash-label">Документы · {files.data?.length ?? 0}</h2>
            <UploadButton target={{ supplierId: s.id }} label="Прикрепить" />
          </div>
          <QueryState loading={files.isLoading} error={files.error} onRetry={() => files.refetch()} empty={files.data?.length === 0}
            emptyText="Документов нет" emptyHint="Договор, прайс, счета">
            <FileList files={files.data ?? []} />
          </QueryState>
        </section>
        <section className="dash-card min-w-0 p-4" aria-label="История">
          <h2 className="dash-label mb-3">История</h2>
          <ActivityList entityId={s.id} empty="Событий пока нет" />
        </section>
      </div>

      <div className="mt-6 flex justify-end border-t border-[var(--d-line)] pt-4">
        <button className="dash-btn dash-btn-ghost dash-btn-sm !text-[var(--d-danger)]" disabled={del.isPending}
          onClick={() => confirm(`Удалить поставщика «${s.name}»? У ${list.length} компонентов поле «Поставщик» станет пустым, документы удалятся.`) && del.mutate()}>
          <Trash2 className="h-4 w-4" aria-hidden /> Удалить
        </button>
      </div>
    </div>
  )
}

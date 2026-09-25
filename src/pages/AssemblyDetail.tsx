import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, ArrowLeft, Boxes, Pencil, Trash2 } from 'lucide-react'
import { deleteAssembly, fetchAssembly, updateAssembly, type AssemblyInput } from '../catalog'
import { fetchAttachments } from '../api'
import { AssemblyForm, useCosting } from '../catalogParts'
import { BatchNeeds, BomEditor, UsedIn } from '../bom'
import { fmtMoney } from '../money'
import Md from '../Md'
import { ActivityList, FileList, UploadButton } from '../shared'
import { PageHeader, QueryState, errMsg, useToast } from '../ui'

export default function AssemblyDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState(false)

  const q = useQuery({ queryKey: ['assembly', id], queryFn: () => fetchAssembly(id) })
  const files = useQuery({ queryKey: ['attachments', 'assembly', id], queryFn: () => fetchAttachments({ assemblyId: id }) })
  const c = useCosting()

  const save = useMutation({
    mutationFn: (patch: Partial<AssemblyInput & { archived_at: string | null }>) => updateAssembly(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assembly', id] })
      qc.invalidateQueries({ queryKey: ['assemblies'] })
      qc.invalidateQueries({ queryKey: ['activity'] })
    },
    onError: e => toast(errMsg(e), 'error'),
  })
  const del = useMutation({
    mutationFn: () => deleteAssembly(id),
    onSuccess: () => { toast('Узел удалён'); qc.invalidateQueries({ queryKey: ['assemblies'] }); qc.invalidateQueries({ queryKey: ['bom'] }); nav('/assemblies') },
    onError: e => toast(errMsg(e), 'error'),
  })

  const a = q.data
  if (!a) return <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty emptyText="Узел не найден"><></></QueryState>

  const cost = c.k?.assembly(a.id)
  const used = c.k?.usedIn({ assemblyId: a.id }).length ?? 0
  const diff = cost && cost.override !== null ? cost.override - cost.calculated : null

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/assemblies" className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> Узлы</Link>
      <PageHeader title={a.name}
        sub={<span className="flex flex-wrap items-center gap-2">
          <span className="dash-chip"><Boxes className="h-3 w-3" aria-hidden /> Узел</span>
          {a.sku && <span className="dash-mono text-xs">{a.sku}</span>}
          {a.archived_at && <span className="dash-chip">В архиве</span>}
        </span>}
        actions={!editing && <button className="dash-btn dash-btn-ghost" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" aria-hidden /> Редактировать</button>} />

      {editing && (
        <section className="dash-card mb-4 p-5" aria-label="Редактирование">
          <AssemblyForm initial={a} submitLabel="Сохранить" busy={save.isPending}
            onSubmit={patch => save.mutate(patch, { onSuccess: () => { setEditing(false); toast('Сохранено') } })}
            onCancel={() => setEditing(false)} />
        </section>
      )}

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <section className="dash-card p-4" aria-label="Стоимость">
          <h2 className="dash-label mb-2">Стоимость узла</h2>
          <div className="text-2xl font-semibold tabular-nums">{fmtMoney(cost?.total ?? null, 'RUB')}</div>
          <dl className="mt-3 space-y-1 border-t border-[var(--d-line)] pt-2 text-xs">
            <div className="flex justify-between gap-2"><dt className="dash-muted">По составу</dt><dd className="tabular-nums">{fmtMoney(cost?.calculated ?? null, 'RUB')}</dd></div>
            <div className="flex justify-between gap-2"><dt className="dash-muted">Ручная</dt><dd className="tabular-nums">{cost?.override === null || cost?.override === undefined ? 'не задана' : fmtMoney(cost.override, 'RUB')}</dd></div>
            {diff !== null && (
              <div className="flex justify-between gap-2 text-[var(--d-warn)]"><dt>Разница</dt><dd className="tabular-nums">{diff > 0 ? '+' : ''}{fmtMoney(diff, 'RUB')}</dd></div>
            )}
          </dl>
        </section>
        <section className="dash-card p-4 md:col-span-2" aria-label="Где используется">
          <h2 className="dash-label mb-2">Где используется · {used}</h2>
          <UsedIn target={{ assemblyId: a.id }} />
        </section>
      </div>

      {(a.description || a.notes) && !editing && (
        <section className="dash-card mb-4 grid gap-4 p-4 md:grid-cols-2" aria-label="Описание">
          {a.description && <div><h2 className="dash-label mb-1.5">Описание</h2><Md>{a.description}</Md></div>}
          {a.notes && <div><h2 className="dash-label mb-1.5">Заметки</h2><Md>{a.notes}</Md></div>}
        </section>
      )}

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Состав">
        <h2 className="dash-label mb-3">Состав узла</h2>
        <BomEditor parent={{ assemblyId: a.id }} />
      </section>

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Потребность на партию">
        <h2 className="dash-label mb-3">Потребность в компонентах</h2>
        <BatchNeeds parent={{ assemblyId: a.id }} title={a.name} />
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="dash-card min-w-0 p-4" aria-label="Документы">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="dash-label">Документы · {files.data?.length ?? 0}</h2>
            <UploadButton target={{ assemblyId: a.id }} label="Прикрепить" />
          </div>
          <QueryState loading={files.isLoading} error={files.error} onRetry={() => files.refetch()} empty={files.data?.length === 0}
            emptyText="Документов нет" emptyHint="Схема, сборочный чертёж, фото">
            <FileList files={files.data ?? []} />
          </QueryState>
        </section>
        <section className="dash-card min-w-0 p-4" aria-label="История">
          <h2 className="dash-label mb-3">История</h2>
          <ActivityList entityId={a.id} empty="Изменений пока нет" />
        </section>
      </div>

      <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-[var(--d-line)] pt-4">
        {a.archived_at
          ? <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => save.mutate({ archived_at: null })}><ArchiveRestore className="h-4 w-4" aria-hidden /> Вернуть из архива</button>
          : <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => save.mutate({ archived_at: new Date().toISOString() }, { onSuccess: () => toast('Узел в архиве') })}><Archive className="h-4 w-4" aria-hidden /> В архив</button>}
        <button className="dash-btn dash-btn-ghost dash-btn-sm !text-[var(--d-danger)]" disabled={del.isPending}
          onClick={() => confirm(used
            ? `Узел «${a.name}» стоит в составе ${used} изделий/узлов — он пропадёт оттуда, себестоимость изменится. Удалить?`
            : `Удалить узел «${a.name}»?`) && del.mutate()}>
          <Trash2 className="h-4 w-4" aria-hidden /> Удалить
        </button>
      </div>
    </div>
  )
}

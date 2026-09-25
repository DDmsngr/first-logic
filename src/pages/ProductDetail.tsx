import { TestsPanel } from '../qualityUi'
import { BuildPanel } from '../builds'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, ArrowLeft, FileText, Pencil, Plus, Trash2 } from 'lucide-react'
import { deleteProduct, fetchProduct, sellingPrice, updateProduct, type ProductInput } from '../catalog'
import { fetchAttachments, fetchTasks } from '../api'
import { useWorkspace } from '../auth'
import { Price, ProductForm, SpecsEditor, useCosting, useDicts, useRates } from '../catalogParts'
import { BatchNeeds, BomEditor } from '../bom'
import { EconomicsCard } from '../economics'
import { unitEconomics } from '../costing'
import { fmtMoney, toRub } from '../money'
import Md from '../Md'
import { ActivityList, FileList, UploadButton } from '../shared'
import { CreateTaskModal, DueLabel, PriorityChip, StatusChip } from '../taskParts'
import { Avatar, PageHeader, QueryState, errMsg, useToast } from '../ui'

export default function ProductDetail() {
  const { id = '' } = useParams()
  const { project, byUser } = useWorkspace()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [editingSpecs, setEditingSpecs] = useState(false)
  const [newTask, setNewTask] = useState(false)
  const [showDone, setShowDone] = useState(false)

  const q = useQuery({ queryKey: ['product', id], queryFn: () => fetchProduct(id) })
  const statuses = useDicts('product_status')
  const tasks = useQuery({
    queryKey: ['tasks', project.id, { sort: 'priority', product: id }],
    queryFn: () => fetchTasks(project.id, { sort: 'priority', product: id }),
  })
  const files = useQuery({ queryKey: ['attachments', 'product', id], queryFn: () => fetchAttachments({ productId: id }) })
  const costing = useCosting()
  const rates = useRates()

  const save = useMutation({
    mutationFn: (patch: Partial<ProductInput & { archived_at: string | null }>) => updateProduct(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['product', id] })
      qc.invalidateQueries({ queryKey: ['products'] })
      qc.invalidateQueries({ queryKey: ['activity'] })
    },
    onError: e => toast(errMsg(e), 'error'),
  })
  const del = useMutation({
    mutationFn: () => deleteProduct(id),
    onSuccess: () => { toast('Изделие удалено'); qc.invalidateQueries({ queryKey: ['products'] }); qc.invalidateQueries({ queryKey: ['tasks'] }); nav('/products') },
    onError: e => toast(errMsg(e), 'error'),
  })

  const p = q.data
  if (!p) return <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty emptyText="Изделие не найдено"><></></QueryState>

  const status = statuses.data?.find(s => s.id === p.status_id)
  const cost = costing.k?.product(p.id)
  const material = cost?.total ?? null
  const bomLines = cost?.lines.length ?? 0
  const price = sellingPrice(p)
  const priceRub = price === null ? null : toRub(price, p.price_currency, rates.data ?? [])
  const econ = unitEconomics(material ?? 0, p, priceRub)
  const all = tasks.data ?? []
  const open = all.filter(t => t.status !== 'done')
  const done = all.filter(t => t.status === 'done')
  const shown = showDone ? all : open

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/products" className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> Изделия</Link>
      <PageHeader
        title={`${p.name}${p.version ? ` ${p.version}` : ''}`}
        sub={<span className="flex flex-wrap items-center gap-2">
          {p.sku && <span className="dash-mono text-xs">{p.sku}</span>}
          {p.archived_at && <span className="dash-chip">В архиве</span>}
        </span>}
        actions={<>
          <select className="dash-input !w-auto" aria-label="Статус изделия" value={p.status_id ?? ''}
            style={status ? { color: status.color, borderColor: `${status.color}66` } : undefined}
            onChange={e => save.mutate({ status_id: e.target.value || null })}>
            <option value="">Без статуса</option>
            {statuses.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <Link to={`/products/${p.id}/offer`} className="dash-btn dash-btn-ghost"><FileText className="h-4 w-4" aria-hidden /> КП</Link>
          {!editing && <button className="dash-btn dash-btn-ghost" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" aria-hidden /> Редактировать</button>}
        </>} />

      {editing && (
        <section className="dash-card mb-4 p-5" aria-label="Редактирование">
          <ProductForm initial={p} submitLabel="Сохранить" busy={save.isPending}
            onSubmit={patch => save.mutate(patch, { onSuccess: () => { setEditing(false); toast('Сохранено') } })}
            onCancel={() => setEditing(false)} />
        </section>
      )}

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <section className="dash-card p-4" aria-label="Цена">
          <h2 className="dash-label mb-2">Цена продажи</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex items-start justify-between gap-2"><dt className="dash-muted">Плановая</dt><dd className="text-right">{p.planned_price === null ? '—' : <Price amount={p.planned_price} currency={p.price_currency} />}</dd></div>
            <div className="flex items-start justify-between gap-2"><dt className="dash-muted">Фактическая</dt><dd className="text-right font-semibold">{p.actual_price === null ? '—' : <Price amount={p.actual_price} currency={p.price_currency} />}</dd></div>
          </dl>
          <div className="mt-3 space-y-1 border-t border-[var(--d-line)] pt-2 text-sm">
            <div className="flex justify-between gap-2"><span className="dash-muted">Себестоимость</span><b className="tabular-nums">{fmtMoney(econ.total, 'RUB')}</b></div>
            <div className="flex justify-between gap-2"><span className="dash-muted">Маржа</span>
              <b className={`tabular-nums ${econ.margin === null ? '' : econ.margin >= 0 ? 'text-[var(--d-ok)]' : 'text-[var(--d-danger)]'}`}>{econ.margin === null ? '—' : `${econ.margin.toFixed(1)}%`}</b></div>
          </div>
        </section>

        <section className="dash-card p-4 md:col-span-2" aria-label="Характеристики">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="dash-label">Характеристики</h2>
            {!editingSpecs && <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setEditingSpecs(true)}><Pencil className="h-3.5 w-3.5" aria-hidden /> Изменить</button>}
          </div>
          {editingSpecs ? (
            <SpecsEditor specs={p.specs} busy={save.isPending} onCancel={() => setEditingSpecs(false)}
              onSave={specs => save.mutate({ specs }, { onSuccess: () => { setEditingSpecs(false); toast('Характеристики сохранены') } })} />
          ) : p.specs.length === 0 ? (
            <p className="dash-muted text-sm">Не заданы. Мощность, диапазон частот, усиление, питание, КСВ — всё, что важно для изделия.</p>
          ) : (
            <dl className="grid gap-x-6 sm:grid-cols-2">
              {p.specs.map((s, i) => (
                <div key={i} className="dash-row flex items-baseline justify-between gap-3 py-1.5 text-sm">
                  <dt className="dash-muted">{s.name}</dt>
                  <dd className="text-right font-medium tabular-nums">{s.value}{s.unit && <span className="dash-muted font-normal"> {s.unit}</span>}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>

      {(p.description || p.notes) && !editing && (
        <section className="dash-card mb-4 grid gap-4 p-4 md:grid-cols-2" aria-label="Описание">
          {p.description && <div><h2 className="dash-label mb-1.5">Описание</h2><Md>{p.description}</Md></div>}
          {p.notes && <div><h2 className="dash-label mb-1.5">Заметки</h2><Md>{p.notes}</Md></div>}
        </section>
      )}

      <div className="mb-4"><EconomicsCard product={p} u={econ} hasBom={bomLines > 0} /></div>

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Состав изделия">
        <h2 className="dash-label mb-3">Состав (BOM)</h2>
        <BomEditor parent={{ productId: p.id }} />
      </section>

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Потребность на партию">
        <h2 className="dash-label mb-3">Потребность в компонентах на партию</h2>
        <BatchNeeds parent={{ productId: p.id }} title={`${p.name}${p.version ? ' ' + p.version : ''}`} />
      </section>

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Сборка">
        <h2 className="dash-label mb-3">Сборка — списание со склада</h2>
        <BuildPanel target={{ productId: p.id }} />
      </section>

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Испытания">
        <h2 className="dash-label mb-3">Испытания</h2>
        <TestsPanel product={p} />
      </section>

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Задачи изделия">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="dash-label">Задачи · {open.length} открытых{done.length > 0 && `, ${done.length} готово`}</h2>
          <div className="flex gap-2">
            {done.length > 0 && <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setShowDone(v => !v)}>{showDone ? 'Скрыть готовые' : 'Показать готовые'}</button>}
            <Link to={`/tasks?product=${p.id}`} className="dash-btn dash-btn-ghost dash-btn-sm">На доске</Link>
            <button className="dash-btn dash-btn-sm" onClick={() => setNewTask(true)}><Plus className="h-4 w-4" aria-hidden /> Задача</button>
          </div>
        </div>
        <QueryState loading={tasks.isLoading} error={tasks.error} onRetry={() => tasks.refetch()} empty={shown.length === 0}
          emptyText={all.length ? 'Открытых задач нет' : 'Задач по изделию пока нет'}>
          <ul>
            {shown.map(t => (
              <li key={t.id} className="dash-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1 basis-48 truncate text-sm font-medium hover:underline">
                  <span className="dash-muted mr-1 font-mono text-xs font-normal">#{t.num}</span>{t.title}
                </Link>
                <StatusChip status={t.status} /><PriorityChip priority={t.priority} />
                {t.due_date && <DueLabel task={t} />}
                <Avatar member={byUser(t.assignee_id)} size={22} />
              </li>
            ))}
          </ul>
        </QueryState>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="dash-card min-w-0 p-4" aria-label="Фото и документы">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="dash-label">Фото и документы · {files.data?.length ?? 0}</h2>
            <UploadButton target={{ productId: p.id }} label="Прикрепить" />
          </div>
          <QueryState loading={files.isLoading} error={files.error} onRetry={() => files.refetch()} empty={files.data?.length === 0}
            emptyText="Файлов нет" emptyHint="Фото, схема, чертежи, протокол испытаний">
            <FileList files={files.data ?? []} />
          </QueryState>
        </section>
        <section className="dash-card min-w-0 p-4" aria-label="История">
          <h2 className="dash-label mb-3">История</h2>
          <ActivityList entityId={p.id} empty="Изменений пока нет" />
        </section>
      </div>

      <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-[var(--d-line)] pt-4">
        {p.archived_at
          ? <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => save.mutate({ archived_at: null })}><ArchiveRestore className="h-4 w-4" aria-hidden /> Вернуть из архива</button>
          : <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => save.mutate({ archived_at: new Date().toISOString() }, { onSuccess: () => toast('Изделие в архиве') })}><Archive className="h-4 w-4" aria-hidden /> В архив</button>}
        <button className="dash-btn dash-btn-ghost dash-btn-sm !text-[var(--d-danger)]" disabled={del.isPending}
          onClick={() => confirm(`Удалить «${p.name}» безвозвратно? Задачи останутся, но потеряют связь с изделием; файлы изделия удалятся. Если оно ещё может понадобиться — лучше в архив.`) && del.mutate()}>
          <Trash2 className="h-4 w-4" aria-hidden /> Удалить
        </button>
      </div>

      {newTask && <CreateTaskModal open onClose={() => { setNewTask(false); qc.invalidateQueries({ queryKey: ['tasks'] }) }} initialProductId={p.id} />}
    </div>
  )
}


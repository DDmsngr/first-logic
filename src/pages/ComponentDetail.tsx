import { ComponentReservations, ReservedNote } from '../reservations'
import { PriceHistory } from '../currencyRisk'
import { OffersPanel } from '../offers'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, ArrowLeft, ExternalLink, Minus, Pencil, Plus, QrCode, Trash2 } from 'lucide-react'
import { deleteComponent, fetchComponent, needsReorder, updateComponent, type ComponentInput } from '../catalog'
import { fetchAttachments } from '../api'
import { ComponentForm, ComponentStatusChip, DictChip, Price, Stock, useDicts, useRates, useSuppliers } from '../catalogParts'
import { fmtMoney, fmtQty, parseAmount, toRub } from '../money'
import { fmtDateTime } from '../meta'
import { ActivityList, FileList, UploadButton } from '../shared'
import { UsedIn } from '../bom'
import { PageHeader, QueryState, errMsg, useToast } from '../ui'

export default function ComponentDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [delta, setDelta] = useState('')

  const q = useQuery({ queryKey: ['component', id], queryFn: () => fetchComponent(id) })
  const files = useQuery({ queryKey: ['attachments', 'component', id], queryFn: () => fetchAttachments({ componentId: id }) })
  const dicts = useDicts('component_category')
  const sups = useSuppliers()
  const rates = useRates()

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['component', id] })
    qc.invalidateQueries({ queryKey: ['components'] })
    qc.invalidateQueries({ queryKey: ['activity'] })
  }
  const save = useMutation({
    mutationFn: (patch: Partial<ComponentInput & { archived_at: string | null }>) => updateComponent(id, patch),
    onSuccess: refresh,
    onError: e => toast(errMsg(e), 'error'),
  })
  const del = useMutation({
    mutationFn: () => deleteComponent(id),
    onSuccess: () => { toast('Компонент удалён'); qc.invalidateQueries({ queryKey: ['components'] }); nav('/components') },
    onError: e => toast(errMsg(e), 'error'),
  })

  const c = q.data
  if (!c) {
    return <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty emptyText="Компонент не найден"><></></QueryState>
  }

  const cat = dicts.data?.find(d => d.id === c.category_id)
  const sup = sups.data?.find(s => s.id === c.supplier_id)
  const unitRub = toRub(c.price, c.currency, rates.data ?? [])
  const move = (sign: 1 | -1) => (e?: FormEvent) => {
    e?.preventDefault()
    const n = delta.trim() ? parseAmount(delta) : 1
    if (!Number.isFinite(n) || n <= 0) { toast('Количество должно быть положительным числом', 'error'); return }
    save.mutate({ stock: c.stock + sign * n }, { onSuccess: () => { setDelta(''); toast(sign > 0 ? `Приход: +${fmtQty(n)} ${c.unit}` : `Расход: −${fmtQty(n)} ${c.unit}`) } })
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/components" className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> Компоненты</Link>
      <PageHeader title={c.name}
        sub={<span className="flex flex-wrap items-center gap-2">
          <DictChip dict={cat} /><ComponentStatusChip status={c.status} />
          {c.archived_at && <span className="dash-chip">В архиве</span>}
          {c.sku && <span className="dash-mono text-xs">{c.sku}</span>}
          {c.manufacturer && <span className="text-xs">{c.manufacturer}</span>}
        </span>}
        actions={!editing && <>
          <Link className="dash-btn dash-btn-ghost" to={`/components/labels?ids=${c.id}`}><QrCode className="h-4 w-4" aria-hidden /> Этикетка</Link>
          <button className="dash-btn dash-btn-ghost" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" aria-hidden /> Редактировать</button>
        </>} />

      <ComponentReservations componentId={c.id} unit={c.unit} />

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <section className="dash-card p-4" aria-label="Склад">
          <h2 className="dash-label mb-2">Склад</h2>
          <div className="text-3xl font-semibold"><Stock c={c} /></div>
          <ReservedNote id={c.id} stock={c.stock} unit={c.unit} />
          <p className="dash-muted mt-1 text-xs">
            {c.min_stock > 0 ? `Минимум ${fmtQty(c.min_stock)} ${c.unit}` : 'Минимум не задан'}
            {needsReorder(c) && <span className="ml-1 text-[var(--d-warn)]">— пора заказать</span>}
          </p>
          <form onSubmit={move(1)} className="mt-3 flex gap-2">
            <input className="dash-input !min-h-9" inputMode="decimal" placeholder="1" value={delta} onChange={e => setDelta(e.target.value)} aria-label="Количество" />
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !min-h-9 shrink-0" disabled={save.isPending} onClick={() => move(-1)()} aria-label="Расход со склада" title="Расход">
              <Minus className="h-4 w-4" aria-hidden />
            </button>
            <button className="dash-btn dash-btn-sm !min-h-9 shrink-0" disabled={save.isPending} aria-label="Приход на склад" title="Приход">
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </form>
        </section>

        <section className="dash-card p-4" aria-label="Цена">
          <h2 className="dash-label mb-2">Цена за {c.unit}</h2>
          <div className="text-2xl font-semibold"><Price amount={c.price} currency={c.currency} /></div>
          <p className="dash-muted mt-2 text-xs">
            Запас на складе: {fmtMoney(unitRub === null ? null : Math.max(c.stock, 0) * unitRub, 'RUB')}
          </p>
        </section>

        <section className="dash-card p-4 text-sm" aria-label="Закупка">
          <h2 className="dash-label mb-2">Закупка</h2>
          <dl className="space-y-1.5">
            <div className="flex gap-2"><dt className="dash-muted w-24 shrink-0">Поставщик</dt><dd className="min-w-0 truncate">{sup ? <Link className="hover:underline" to={`/suppliers/${sup.id}`}>{sup.name}</Link> : '—'}</dd></div>
            <div className="flex gap-2"><dt className="dash-muted w-24 shrink-0">Ссылка</dt><dd className="min-w-0 truncate">{c.url ? <a className="inline-flex items-center gap-1 text-[var(--d-accent)] hover:underline" href={c.url} target="_blank" rel="noopener noreferrer">открыть <ExternalLink className="h-3 w-3" aria-hidden /></a> : '—'}</dd></div>
            <div className="flex gap-2"><dt className="dash-muted w-24 shrink-0">Хранение</dt><dd className="min-w-0">{c.location || '—'}</dd></div>
            <div className="flex gap-2"><dt className="dash-muted w-24 shrink-0">Изменён</dt><dd>{fmtDateTime(c.updated_at)}</dd></div>
          </dl>
        </section>
      </div>

      {editing ? (
        <section className="dash-card mb-4 p-5" aria-label="Редактирование">
          <h2 className="dash-label mb-4">Редактирование</h2>
          <ComponentForm initial={c} submitLabel="Сохранить" busy={save.isPending}
            onSubmit={patch => save.mutate(patch, { onSuccess: () => { setEditing(false); toast('Сохранено') } })}
            onCancel={() => setEditing(false)} />
        </section>
      ) : c.notes && (
        <section className="dash-card mb-4 p-4" aria-label="Примечание">
          <h2 className="dash-label mb-2">Примечание</h2>
          <p className="whitespace-pre-wrap text-sm">{c.notes}</p>
        </section>
      )}

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Поставщики и цены">
        <h2 className="dash-label mb-2">Поставщики и цены</h2>
        <OffersPanel c={c} />
      </section>

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="История цены">
        <h2 className="dash-label mb-2">История цены</h2>
        <PriceHistory componentId={c.id} />
      </section>

      <section className="dash-card mb-4 min-w-0 p-4" aria-label="Где используется">
        <h2 className="dash-label mb-2">Где используется</h2>
        <UsedIn target={{ componentId: c.id }} />
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="dash-card min-w-0 p-4" aria-label="Фото и документы">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="dash-label">Фото и документы · {files.data?.length ?? 0}</h2>
            <UploadButton target={{ componentId: c.id }} label="Прикрепить" />
          </div>
          <QueryState loading={files.isLoading} error={files.error} onRetry={() => files.refetch()} empty={files.data?.length === 0}
            emptyText="Файлов нет" emptyHint="Datasheet, фото, чертёж">
            <FileList files={files.data ?? []} />
          </QueryState>
        </section>
        <section className="dash-card min-w-0 p-4" aria-label="История">
          <h2 className="dash-label mb-3">История</h2>
          <ActivityList entityId={c.id} empty="Изменений пока нет" />
        </section>
      </div>

      <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-[var(--d-line)] pt-4">
        {c.archived_at
          ? <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => save.mutate({ archived_at: null })}><ArchiveRestore className="h-4 w-4" aria-hidden /> Вернуть из архива</button>
          : <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => save.mutate({ archived_at: new Date().toISOString() }, { onSuccess: () => toast('Компонент в архиве') })}><Archive className="h-4 w-4" aria-hidden /> В архив</button>}
        <button className="dash-btn dash-btn-ghost dash-btn-sm !text-[var(--d-danger)]" disabled={del.isPending}
          onClick={() => confirm(`Удалить «${c.name}» безвозвратно? Файлы компонента тоже удалятся. Если он ещё может понадобиться — лучше в архив.`) && del.mutate()}>
          <Trash2 className="h-4 w-4" aria-hidden /> Удалить
        </button>
      </div>
    </div>
  )
}

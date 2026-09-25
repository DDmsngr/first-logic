import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListChecks, Plus, Tags } from 'lucide-react'
import { createProduct, fetchProducts, sellingPrice, type ProductInput } from '../catalog'
import { fetchTasks } from '../api'
import { useWorkspace } from '../auth'
import { DictChip, DictEditor, EMPTY_PRODUCT, Price, ProductForm, useDicts } from '../catalogParts'
import { Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'

export default function Products() {
  const { workspace, project } = useWorkspace()
  const [sp, setSp] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [editStatuses, setEditStatuses] = useState(false)

  const q = sp.get('q') ?? ''
  const status = sp.get('status') ?? ''
  const archived = sp.get('archived') === '1'
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set(k, v); else n.delete(k)
    setSp(n, { replace: true })
  }

  const list = useQuery({ queryKey: ['products', workspace.id, { archived }], queryFn: () => fetchProducts(workspace.id, archived) })
  const statuses = useDicts('product_status')
  const tasks = useQuery({ queryKey: ['tasks', project.id, { sort: 'priority' }], queryFn: () => fetchTasks(project.id, { sort: 'priority' }) })

  const openTasks = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tasks.data ?? []) if (t.product_id && t.status !== 'done') m.set(t.product_id, (m.get(t.product_id) ?? 0) + 1)
    return m
  }, [tasks.data])

  const statusById = new Map((statuses.data ?? []).map(s => [s.id, s]))
  const statusPos = (id: string | null) => (id ? statusById.get(id)?.position ?? 99 : 100)
  const needle = q.trim().toLowerCase()
  const all = list.data ?? []
  const items = all
    .filter(p => (!needle || [p.name, p.sku, p.version, p.description].some(v => v?.toLowerCase().includes(needle)))
      && (!status || (status === 'none' ? !p.status_id : p.status_id === status)))
    .sort((a, b) => statusPos(a.status_id) - statusPos(b.status_id) || a.name.localeCompare(b.name, 'ru'))

  const create = useMutation({
    mutationFn: (p: ProductInput) => createProduct(workspace.id, p),
    onSuccess: p => { qc.invalidateQueries({ queryKey: ['products'] }); setCreating(false); toast('Изделие добавлено'); nav(`/products/${p.id}`) },
    onError: e => toast(errMsg(e), 'error'),
  })

  const filtered = needle || status || archived

  return (
    <>
      <PageHeader title="Изделия" sub={`${all.length} ${archived ? 'в архиве' : 'в работе'}`}
        actions={<>
          <button className="dash-btn dash-btn-ghost" onClick={() => setEditStatuses(true)}><Tags className="h-4 w-4" aria-hidden /> Статусы</button>
          <button className="dash-btn" onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Новое изделие</button>
        </>} />

      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-[2fr_1fr_auto]">
        <input className="dash-input col-span-2 md:col-span-1" type="search" placeholder="Название, артикул, версия" value={q}
          onChange={e => setParam('q', e.target.value)} aria-label="Поиск по изделиям" />
        <select className="dash-input" value={status} onChange={e => setParam('status', e.target.value)} aria-label="Статус">
          <option value="">Все статусы</option>
          {statuses.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value="none">Без статуса</option>
        </select>
        <label className="flex min-h-10 items-center gap-2 px-1 text-sm">
          <input type="checkbox" checked={archived} onChange={e => setParam('archived', e.target.checked ? '1' : '')} className="accent-[var(--d-accent)]" />
          Архив
        </label>
      </div>

      <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} empty={items.length === 0}
        emptyText={filtered ? 'Ничего не найдено' : 'Изделий пока нет'} emptyHint={filtered ? undefined : 'Добавьте первый усилитель — дальше к нему привяжутся задачи, BOM и себестоимость'}>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map(p => {
            const price = sellingPrice(p)
            const open = openTasks.get(p.id) ?? 0
            return (
              <li key={p.id}>
                <Link to={`/products/${p.id}`} className="dash-card flex h-full flex-col p-4 transition-colors hover:border-[var(--d-line-strong)]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium">{p.name}{p.version && <span className="dash-muted ml-1.5 font-normal">{p.version}</span>}</div>
                      <div className="dash-muted dash-mono text-xs">{p.sku || '—'}</div>
                    </div>
                    <DictChip dict={p.status_id ? statusById.get(p.status_id) : null} />
                  </div>
                  {p.description && <p className="dash-muted mt-2 line-clamp-2 text-sm">{p.description}</p>}
                  {p.specs.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {p.specs.slice(0, 3).map((s, i) => <span key={i} className="dash-chip">{s.name}: <b className="font-medium text-[var(--d-text)]">{s.value}{s.unit ? ` ${s.unit}` : ''}</b></span>)}
                    </div>
                  )}
                  <div className="mt-auto flex items-end justify-between gap-2 pt-4 text-sm">
                    <div>
                      <div className="dash-label !text-[10px]">{p.actual_price !== null ? 'Цена' : 'План. цена'}</div>
                      {price === null ? <span className="dash-muted">не задана</span> : <Price amount={price} currency={p.price_currency} />}
                    </div>
                    <span className="dash-muted inline-flex items-center gap-1 text-xs"><ListChecks className="h-3.5 w-3.5" aria-hidden />{open} открытых</span>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      </QueryState>

      <Modal open={creating} onClose={() => setCreating(false)} title="Новое изделие">
        {creating && <ProductForm initial={EMPTY_PRODUCT} submitLabel="Добавить" busy={create.isPending}
          onSubmit={p => create.mutate(p)} onCancel={() => setCreating(false)} />}
      </Modal>
      <DictEditor kind="product_status" title="Статусы изделий" open={editStatuses} onClose={() => setEditStatuses(false)}
        usage={id => all.filter(p => p.status_id === id).length} />
    </>
  )
}

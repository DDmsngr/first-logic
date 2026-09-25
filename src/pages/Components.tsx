import ComponentsIO from '../ComponentsIO'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Tags } from 'lucide-react'
import { createComponent, fetchComponents, needsReorder, COMPONENT_STATUSES, type Component } from '../catalog'
import { useWorkspace } from '../auth'
import {
  ComponentForm, ComponentStatusChip, DictChip, DictEditor, EMPTY_COMPONENT, Price, Stock, useDicts, useRates, useSuppliers,
} from '../catalogParts'
import { fmtMoney, toRub } from '../money'
import { Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'

type Sort = 'name' | 'price' | 'stock' | 'updated'

export default function Components() {
  const { workspace } = useWorkspace()
  const [sp, setSp] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [cats, setCats] = useState(false)

  const archived = sp.get('archived') === '1'
  const list = useQuery({ queryKey: ['components', workspace.id, { archived }], queryFn: () => fetchComponents(workspace.id, { archived }) })
  const dicts = useDicts('component_category')
  const sups = useSuppliers()
  const rates = useRates()

  const q = sp.get('q') ?? ''
  const cat = sp.get('cat') ?? ''
  const sup = sp.get('sup') ?? ''
  const status = sp.get('status') ?? ''
  const reorder = sp.get('reorder') === '1'
  const noPrice = sp.get('noprice') === '1'
  const sort = (sp.get('sort') as Sort) || 'name'
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set(k, v); else n.delete(k)
    setSp(n, { replace: true })
  }

  const all = list.data ?? []
  const rub = (c: Component) => toRub(c.price, c.currency, rates.data ?? []) ?? 0
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = all.filter(c =>
      (!needle || [c.name, c.sku, c.manufacturer, c.location, c.notes].some(v => v?.toLowerCase().includes(needle)))
      && (!cat || (cat === 'none' ? !c.category_id : c.category_id === cat))
      && (!sup || (sup === 'none' ? !c.supplier_id : c.supplier_id === sup))
      && (!status || c.status === status)
      && (!reorder || needsReorder(c))
      && (!noPrice || c.price === 0))
    const by: Record<Sort, (a: Component, b: Component) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, 'ru'),
      price: (a, b) => rub(b) - rub(a),
      stock: (a, b) => a.stock - b.stock,
      updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
    }
    return out.sort(by[sort])
  }, [all, q, cat, sup, status, reorder, noPrice, sort, rates.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const reorderCount = all.filter(needsReorder).length
  const noPriceCount = all.filter(c => c.price === 0).length
  const stockValue = all.reduce((s, c) => s + Math.max(c.stock, 0) * rub(c), 0)
  const catById = new Map((dicts.data ?? []).map(d => [d.id, d]))
  const supById = new Map((sups.data ?? []).map(s => [s.id, s]))

  const create = useMutation({
    mutationFn: (c: typeof EMPTY_COMPONENT) => createComponent(workspace.id, c),
    onSuccess: c => {
      qc.invalidateQueries({ queryKey: ['components'] })
      setCreating(false)
      toast('Компонент добавлен')
      nav(`/components/${c.id}`)
    },
    onError: e => toast(errMsg(e), 'error'),
  })

  const filtered = q || cat || sup || status || reorder || archived || noPrice

  return (
    <>
      <PageHeader title="Компоненты"
        sub={<>{all.length} позиций · на складе на {fmtMoney(stockValue, 'RUB')}{reorderCount > 0 && <> · <button className="text-[var(--d-warn)] underline" onClick={() => setParam('reorder', reorder ? '' : '1')}>заказать: {reorderCount}</button></>}{noPriceCount > 0 && <> · <button className="underline" onClick={() => setParam('noprice', noPrice ? '' : '1')}>без цены: {noPriceCount}</button></>}</>}
        actions={<>
          <ComponentsIO />
          <button className="dash-btn dash-btn-ghost" onClick={() => setCats(true)}><Tags className="h-4 w-4" aria-hidden /> Категории</button>
          <button className="dash-btn" onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Новый компонент</button>
        </>} />

      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto_auto_auto]">
        <input className="dash-input col-span-2 lg:col-span-1" type="search" placeholder="Название, артикул, производитель, место" value={q}
          onChange={e => setParam('q', e.target.value)} aria-label="Поиск по компонентам" />
        <select className="dash-input" value={cat} onChange={e => setParam('cat', e.target.value)} aria-label="Категория">
          <option value="">Все категории</option>
          {dicts.data?.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          <option value="none">Без категории</option>
        </select>
        <select className="dash-input" value={sup} onChange={e => setParam('sup', e.target.value)} aria-label="Поставщик">
          <option value="">Все поставщики</option>
          {sups.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value="none">Без поставщика</option>
        </select>
        <select className="dash-input" value={status} onChange={e => setParam('status', e.target.value)} aria-label="Статус">
          <option value="">Любой статус</option>
          {COMPONENT_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <select className="dash-input" value={sort} onChange={e => setParam('sort', e.target.value === 'name' ? '' : e.target.value)} aria-label="Сортировка">
          <option value="name">По названию</option>
          <option value="price">Сначала дорогие</option>
          <option value="stock">Меньше всего на складе</option>
          <option value="updated">Недавно изменённые</option>
        </select>
        <label className="flex min-h-10 items-center gap-2 whitespace-nowrap px-1 text-sm">
          <input type="checkbox" checked={reorder} onChange={e => setParam('reorder', e.target.checked ? '1' : '')} className="accent-[var(--d-accent)]" />
          Заказать
        </label>
        <label className="flex min-h-10 items-center gap-2 whitespace-nowrap px-1 text-sm">
          <input type="checkbox" checked={noPrice} onChange={e => setParam('noprice', e.target.checked ? '1' : '')} className="accent-[var(--d-accent)]" />
          Без цены
        </label>
        <label className="flex min-h-10 items-center gap-2 whitespace-nowrap px-1 text-sm">
          <input type="checkbox" checked={archived} onChange={e => setParam('archived', e.target.checked ? '1' : '')} className="accent-[var(--d-accent)]" />
          Архив
        </label>
      </div>

      <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()}
        empty={items.length === 0}
        emptyText={filtered ? 'По фильтрам ничего не найдено' : 'Компонентов пока нет'}
        emptyHint={filtered ? 'Сбросьте часть фильтров' : 'Добавьте первый — транзистор, разъём, корпус'}>
        {/* desktop: таблица */}
        <div className="dash-card hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="dash-label border-b border-[var(--d-line)] text-left">
                <th className="px-4 py-3 font-medium">Компонент</th>
                <th className="px-3 py-3 font-medium">Категория</th>
                <th className="px-3 py-3 font-medium">Поставщик</th>
                <th className="px-3 py-3 text-right font-medium">Цена</th>
                <th className="px-3 py-3 text-right font-medium">Остаток</th>
                <th className="px-3 py-3 font-medium">Место</th>
                <th className="px-4 py-3 font-medium">Статус</th>
              </tr>
            </thead>
            <tbody>
              {items.map(c => (
                <tr key={c.id} className="dash-row cursor-pointer align-top transition-colors hover:bg-[var(--d-raised)]"
                  onClick={e => { if (!(e.target as HTMLElement).closest('a')) nav(`/components/${c.id}`) }}>
                  <td className="px-4 py-3">
                    <Link to={`/components/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                    <div className="dash-muted dash-mono text-xs">{[c.sku, c.manufacturer].filter(Boolean).join(' · ') || '—'}</div>
                  </td>
                  <td className="px-3 py-3"><DictChip dict={c.category_id ? catById.get(c.category_id) : null} /></td>
                  <td className="px-3 py-3">{c.supplier_id ? <Link to={`/suppliers/${c.supplier_id}`} className="hover:underline">{supById.get(c.supplier_id)?.name ?? '—'}</Link> : <span className="dash-muted">—</span>}</td>
                  <td className="px-3 py-3 text-right"><Price amount={c.price} currency={c.currency} /></td>
                  <td className="px-3 py-3 text-right"><Stock c={c} /></td>
                  <td className="dash-muted px-3 py-3">{c.location || '—'}</td>
                  <td className="px-4 py-3"><ComponentStatusChip status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* mobile: карточки */}
        <ul className="space-y-2 md:hidden">
          {items.map(c => (
            <li key={c.id}>
              <Link to={`/components/${c.id}`} className="dash-card block p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{c.name}</div>
                    <div className="dash-muted dash-mono truncate text-xs">{[c.sku, c.manufacturer].filter(Boolean).join(' · ') || '—'}</div>
                  </div>
                  <Price amount={c.price} currency={c.currency} className="shrink-0 text-right text-sm" />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <DictChip dict={c.category_id ? catById.get(c.category_id) : null} />
                  <span className="ml-auto"><Stock c={c} /></span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </QueryState>

      <Modal open={creating} onClose={() => setCreating(false)} title="Новый компонент">
        {creating && <ComponentForm initial={EMPTY_COMPONENT} submitLabel="Добавить" busy={create.isPending}
          onSubmit={c => create.mutate(c)} onCancel={() => setCreating(false)} />}
      </Modal>
      <DictEditor kind="component_category" title="Категории компонентов" open={cats} onClose={() => setCats(false)}
        usage={id => all.filter(c => c.category_id === id).length} />
    </>
  )
}

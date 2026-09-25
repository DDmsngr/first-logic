import ComponentsIO, { OrderFromList } from '../ComponentsIO'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Tags } from 'lucide-react'
import { createComponent, fetchComponents, needsReorder, COMPONENT_STATUSES, type Component } from '../catalog'
import { useWorkspace } from '../auth'
import {
  ComponentForm, ComponentStatusChip, DictChip, DictEditor, EMPTY_COMPONENT, Price, Stock, useDicts, useRates, useSuppliers,
} from '../catalogParts'
import { fmtMoney, toRub } from '../money'
import { Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'

type Sort = 'name' | 'category' | 'supplier' | 'price' | 'stock' | 'location' | 'status' | 'updated'
const SORTS: Sort[] = ['name', 'category', 'supplier', 'price', 'stock', 'location', 'status', 'updated']

export default function Components() {
  const { workspace } = useWorkspace()
  const [sp, setSp] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [cats, setCats] = useState(false)
  const [sel, setSel] = useState<Set<string>>(() => new Set())

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
  const sortParam = sp.get('sort') as Sort
  const sort: Sort = SORTS.includes(sortParam) ? sortParam : 'name'
  // «недавно изменённые» по умолчанию идут от новых к старым, остальное — по возрастанию
  const dir: 'asc' | 'desc' = sp.get('dir') === 'desc' ? 'desc' : sp.get('dir') === 'asc' ? 'asc' : sort === 'updated' ? 'desc' : 'asc'
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
    const catName = new Map((dicts.data ?? []).map(d => [d.id, d.name]))
    const supName = new Map((sups.data ?? []).map(s => [s.id, s.name]))
    const ru = (a: string, b: string) => a.localeCompare(b, 'ru')
    const statusIdx = (c: Component) => COMPONENT_STATUSES.findIndex(s => s.id === c.status)
    // пустое (нет категории, поставщика, места, цены) всегда в конце — при любом направлении
    const empty: Record<Sort, (c: Component) => boolean> = {
      name: () => false, updated: () => false, stock: () => false, status: () => false,
      category: c => !c.category_id, supplier: c => !c.supplier_id, location: c => !c.location, price: c => c.price === 0,
    }
    const cmp: Record<Sort, (a: Component, b: Component) => number> = {
      name: (a, b) => ru(a.name, b.name),
      category: (a, b) => ru(catName.get(a.category_id ?? '') ?? '', catName.get(b.category_id ?? '') ?? ''),
      supplier: (a, b) => ru(supName.get(a.supplier_id ?? '') ?? '', supName.get(b.supplier_id ?? '') ?? ''),
      price: (a, b) => rub(a) - rub(b),
      stock: (a, b) => a.stock - b.stock,
      location: (a, b) => ru(a.location ?? '', b.location ?? ''),
      status: (a, b) => statusIdx(a) - statusIdx(b),
      updated: (a, b) => a.updated_at.localeCompare(b.updated_at),
    }
    const sign = dir === 'desc' ? -1 : 1
    return out.sort((a, b) => {
      const ea = empty[sort](a), eb = empty[sort](b)
      if (ea !== eb) return ea ? 1 : -1
      return sign * cmp[sort](a, b) || ru(a.name, b.name)
    })
  }, [all, q, cat, sup, status, reorder, noPrice, sort, dir, rates.data, dicts.data, sups.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const reorderCount = all.filter(needsReorder).length
  const noPriceCount = all.filter(c => c.price === 0).length
  const stockValue = all.reduce((s, c) => s + Math.max(c.stock, 0) * rub(c), 0)
  // выбор переживает смену фильтров: можно отметить позиции у разных поставщиков
  const selected = all.filter(c => sel.has(c.id))
  const shownSelected = items.filter(c => sel.has(c.id)).length
  const toggle = (id: string) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const toggleAll = () => setSel(prev => {
    const n = new Set(prev)
    if (shownSelected === items.length) items.forEach(c => n.delete(c.id)); else items.forEach(c => n.add(c.id))
    return n
  })
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
          <OrderFromList items={selected.length ? selected : items} scope={selected.length ? 'selected' : 'list'} />
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
        <select className="dash-input" value={`${sort}:${dir}`} aria-label="Сортировка"
          onChange={e => {
            const [k, d] = e.target.value.split(':')
            const n = new URLSearchParams(sp)
            if (k === 'name' && d === 'asc') { n.delete('sort'); n.delete('dir') } else { n.set('sort', k); n.set('dir', d) }
            setSp(n, { replace: true })
          }}>
          <option value="name:asc">По названию А→Я</option>
          <option value="name:desc">По названию Я→А</option>
          <option value="price:desc">Сначала дорогие</option>
          <option value="price:asc">Сначала дешёвые</option>
          <option value="stock:asc">Меньше всего на складе</option>
          <option value="stock:desc">Больше всего на складе</option>
          <option value="category:asc">По категории</option>
          <option value="supplier:asc">По поставщику</option>
          <option value="location:asc">По месту хранения</option>
          <option value="status:asc">По статусу</option>
          <option value="updated:desc">Недавно изменённые</option>
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

      {selected.length > 0 && (
        <div role="status" className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--d-accent)] bg-[var(--d-raised)] px-3 py-2 text-sm">
          <b>Выбрано: {selected.length}</b>
          {selected.length > shownSelected && <span className="dash-muted">(из них {selected.length - shownSelected} скрыто фильтрами)</span>}
          <span className="dash-muted">Кнопка «Выгрузить выбранные» сверху возьмёт только их.</span>
          <button className="dash-btn dash-btn-ghost dash-btn-sm ml-auto" onClick={() => setSel(new Set())}>Снять выбор</button>
        </div>
      )}

      <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()}
        empty={items.length === 0}
        emptyText={filtered ? 'По фильтрам ничего не найдено' : 'Компонентов пока нет'}
        emptyHint={filtered ? 'Сбросьте часть фильтров' : 'Добавьте первый — транзистор, разъём, корпус'}>
        {/* desktop: таблица */}
        <div className="dash-card hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="dash-label border-b border-[var(--d-line)] text-left">
                <th className="w-10 py-3 pl-4 pr-0 font-medium">
                  <input type="checkbox" className="accent-[var(--d-accent)]" aria-label="Выбрать все показанные"
                    checked={items.length > 0 && shownSelected === items.length}
                    ref={el => { if (el) el.indeterminate = shownSelected > 0 && shownSelected < items.length }}
                    onChange={toggleAll} />
                </th>
                {([
                  ['name', 'Компонент', 'px-3'], ['category', 'Категория', 'px-3'], ['supplier', 'Поставщик', 'px-3'],
                  ['price', 'Цена', 'px-3 text-right'], ['stock', 'Остаток', 'px-3 text-right'], ['location', 'Место', 'px-3'], ['status', 'Статус', 'px-4'],
                ] as [Sort, string, string][]).map(([k, label, cls]) => (
                  <th key={k} className={`${cls} py-3 font-medium`} aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => {
                      const n = new URLSearchParams(sp)
                      const next = sort === k ? (dir === 'asc' ? 'desc' : 'asc') : 'asc'
                      if (k === 'name' && next === 'asc') { n.delete('sort'); n.delete('dir') } else { n.set('sort', k); n.set('dir', next) }
                      setSp(n, { replace: true })
                    }} className={`inline-flex items-center gap-1 uppercase tracking-[0.1em] hover:text-[var(--d-text)] ${sort === k ? 'text-[var(--d-accent)]' : ''}`}
                      title={`Сортировать: ${label}`}>
                      {label}
                      {sort === k ? (dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />) : <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(c => (
                <tr key={c.id} className="dash-row cursor-pointer align-top transition-colors hover:bg-[var(--d-raised)]"
                  onClick={e => { if (!(e.target as HTMLElement).closest('a,input,label')) nav(`/components/${c.id}`) }}>
                  <td className="w-10 py-3 pl-4 pr-0">
                    <input type="checkbox" className="accent-[var(--d-accent)]" aria-label={`Выбрать «${c.name}»`}
                      checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
                  </td>
                  <td className="px-3 py-3">
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
            <li key={c.id} className="flex items-stretch gap-2">
              <label className="grid w-9 shrink-0 place-items-center">
                <input type="checkbox" className="h-5 w-5 accent-[var(--d-accent)]" aria-label={`Выбрать «${c.name}»`}
                  checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
              </label>
              <Link to={`/components/${c.id}`} className={`dash-card block min-w-0 flex-1 p-3 ${sel.has(c.id) ? '!border-[var(--d-accent)]' : ''}`}>
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

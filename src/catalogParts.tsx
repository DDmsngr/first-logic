import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import {
  COMPONENT_STATUSES, UNITS, createDict, refreshRates, deleteDict, fetchAllComponents, fetchAssemblies, fetchBomItems, fetchDicts, fetchProducts, fetchRates, fetchSuppliers, needsReorder,
  updateDict, type AssemblyInput, type Component, type ComponentInput, type Dict, type DictKind, type ProductInput, type Spec, type SupplierInput,
} from './catalog'
import { useWorkspace } from './auth'
import { createCosting } from './costing'
import { CURRENCIES, fmtMoney, fmtQty, parseAmount, toRub, type Currency } from './money'
import { Field, Modal, errMsg, useToast } from './ui'

// ── общие запросы ───────────────────────────────────────────────────────────

export function useRates() {
  return useQuery({ queryKey: ['rates'], queryFn: fetchRates, staleTime: 5 * 60_000 })
}

const STALE_MS = 12 * 3600_000

/** Подтягивает курс ЦБ из браузера, если сохранённому больше 12 часов. Раз за сессию. */
export function useAutoRates() {
  const rates = useRates()
  const qc = useQueryClient()
  useEffect(() => {
    if (!rates.data) return
    const newest = Math.max(0, ...rates.data.map(r => (r.fetched_at ? Date.parse(r.fetched_at) : 0)))
    if (Date.now() - newest < STALE_MS) return
    try {
      if (sessionStorage.getItem('fl-rates-tried')) return
      sessionStorage.setItem('fl-rates-tried', '1')
    } catch { /* нет sessionStorage — пробуем всё равно */ }
    refreshRates().then(() => qc.invalidateQueries({ queryKey: ['rates'] })).catch(() => { /* покажет страница курсов */ })
  }, [rates.data, qc])
}

export function useDicts(kind: DictKind) {
  const { workspace } = useWorkspace()
  return useQuery({ queryKey: ['dicts', workspace.id, kind], queryFn: () => fetchDicts(workspace.id, kind) })
}

export function useSuppliers() {
  const { workspace } = useWorkspace()
  return useQuery({ queryKey: ['suppliers', workspace.id], queryFn: () => fetchSuppliers(workspace.id) })
}

/** Узлы (все, включая архивные). */
export function useAssemblies() {
  const { workspace } = useWorkspace()
  return useQuery({ queryKey: ['assemblies', workspace.id], queryFn: () => fetchAssemblies(workspace.id) })
}

/**
 * Всё для расчёта состава: компоненты, узлы, строки BOM и курсы. Возвращает
 * считалку из costing.ts; пока что-то грузится — null.
 */
export function useCosting() {
  const { workspace } = useWorkspace()
  const comps = useQuery({ queryKey: ['components', workspace.id, 'all'], queryFn: () => fetchAllComponents(workspace.id) })
  const asms = useAssemblies()
  const items = useQuery({ queryKey: ['bom', workspace.id], queryFn: () => fetchBomItems(workspace.id) })
  const rates = useRates()
  const ready = comps.data && asms.data && items.data && rates.data
  const k = useMemo(() => (ready ? createCosting({
    components: comps.data!, assemblies: asms.data!, items: items.data!, rates: rates.data!,
  }) : null), [ready, comps.data, asms.data, items.data, rates.data])
  return {
    k, loading: !ready && !(comps.error || asms.error || items.error || rates.error),
    error: comps.error ?? asms.error ?? items.error ?? rates.error,
    components: comps.data ?? [], assemblies: asms.data ?? [], items: items.data ?? [],
    retry: () => { void comps.refetch(); void asms.refetch(); void items.refetch(); void rates.refetch() },
  }
}

export function useProducts() {
  const { workspace } = useWorkspace()
  return useQuery({ queryKey: ['products', workspace.id], queryFn: () => fetchProducts(workspace.id) })
}

/** Выбор изделия для задачи, расхода и т. п. */
export function ProductSelect({ value, onChange, disabled, label = 'Изделие' }: {
  value: string | null; onChange: (id: string | null) => void; disabled?: boolean; label?: string
}) {
  const products = useProducts()
  return (
    <select className="dash-input" aria-label={label} disabled={disabled} value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
      <option value="">Не связана с изделием</option>
      {products.data?.map(p => <option key={p.id} value={p.id}>{p.name}{p.version ? ` ${p.version}` : ''}</option>)}
    </select>
  )
}

// ── отображение ─────────────────────────────────────────────────────────────

/** Цена в своей валюте; для иностранной рядом эквивалент в рублях по текущему курсу. */
export function Price({ amount, currency, per, className = '' }: {
  amount: number; currency: Currency; per?: string; className?: string
}) {
  const rates = useRates()
  const rub = currency === 'RUB' ? null : toRub(amount, currency, rates.data ?? [])
  return (
    <span className={`tabular-nums ${className}`}>
      {fmtMoney(amount, currency)}{per && <span className="dash-muted">/{per}</span>}
      {currency !== 'RUB' && (
        <span className="dash-muted block text-xs" title="По текущему курсу">≈ {rub === null ? 'нет курса' : fmtMoney(rub, 'RUB')}</span>
      )}
    </span>
  )
}

export function DictChip({ dict }: { dict?: Dict | null }) {
  if (!dict) return <span className="dash-muted text-xs">—</span>
  return (
    <span className="dash-chip" style={{ color: dict.color, borderColor: `${dict.color}55` }}>
      <span className="dash-led !h-1.5 !w-1.5" aria-hidden />{dict.name}
    </span>
  )
}

export function ComponentStatusChip({ status }: { status: Component['status'] }) {
  const s = COMPONENT_STATUSES.find(x => x.id === status)!
  return <span className="dash-chip" style={{ color: s.color, borderColor: `${s.color}55` }}>{s.label}</span>
}

/** Остаток; при дошедшем до минимума — предупреждение. */
export function Stock({ c }: { c: Pick<Component, 'stock' | 'min_stock' | 'unit' | 'status'> }) {
  const low = needsReorder(c)
  return (
    <span className={`inline-flex items-center gap-1 tabular-nums ${low ? 'font-semibold text-[var(--d-warn)]' : ''}`}
      title={c.min_stock > 0 ? `Минимум: ${fmtQty(c.min_stock)} ${c.unit}` : undefined}>
      {low && <AlertTriangle className="h-3.5 w-3.5" aria-label="Пора заказать" />}
      {fmtQty(c.stock)} <span className="dash-muted font-normal">{c.unit}</span>
    </span>
  )
}

export const Muted = ({ children }: { children: ReactNode }) => <span className="dash-muted">{children}</span>

// ── ввод суммы ──────────────────────────────────────────────────────────────

/** Сумма + валюта; под полем — эквивалент в рублях, пока вводишь. */
export function MoneyInput({ amount, currency, onAmount, onCurrency, label = 'Цена' }: {
  amount: string; currency: Currency; onAmount: (v: string) => void; onCurrency: (c: Currency) => void; label?: string
}) {
  const rates = useRates()
  const n = parseAmount(amount)
  const rub = currency !== 'RUB' && Number.isFinite(n) ? toRub(n, currency, rates.data ?? []) : null
  return (
    <Field label={label} hint={rub !== null ? `≈ ${fmtMoney(rub, 'RUB')} по текущему курсу` : undefined}>
      <div className="flex gap-2">
        <input className="dash-input" inputMode="decimal" value={amount} onChange={e => onAmount(e.target.value)} aria-label={label} />
        <select className="dash-input !w-24 shrink-0" value={currency} onChange={e => onCurrency(e.target.value as Currency)} aria-label="Валюта">
          {CURRENCIES.map(c => <option key={c.id} value={c.id}>{c.id}</option>)}
        </select>
      </div>
    </Field>
  )
}

// ── форма компонента ────────────────────────────────────────────────────────

const str = (v: string | null | undefined) => v ?? ''
const orNull = (v: string) => (v.trim() ? v.trim() : null)

export const EMPTY_COMPONENT: ComponentInput = {
  name: '', category_id: null, sku: null, manufacturer: null, supplier_id: null, url: null, unit: 'шт',
  price: 0, currency: 'RUB', stock: 0, min_stock: 0, status: 'active', location: null, notes: '',
}

export function ComponentForm({ initial, submitLabel, busy, onSubmit, onCancel }: {
  initial: ComponentInput; submitLabel: string; busy?: boolean
  onSubmit: (c: ComponentInput) => void; onCancel?: () => void
}) {
  const cats = useDicts('component_category')
  const sups = useSuppliers()
  const toast = useToast()
  const [f, setF] = useState({
    name: initial.name, category_id: str(initial.category_id), sku: str(initial.sku), manufacturer: str(initial.manufacturer),
    supplier_id: str(initial.supplier_id), url: str(initial.url), unit: initial.unit, price: String(initial.price),
    currency: initial.currency, stock: String(initial.stock), min_stock: String(initial.min_stock),
    status: initial.status, location: str(initial.location), notes: initial.notes,
  })
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const price = parseAmount(f.price || '0'), stock = parseAmount(f.stock || '0'), min = parseAmount(f.min_stock || '0')
    if (![price, stock, min].every(Number.isFinite)) { toast('Цена и количества должны быть числами', 'error'); return }
    if (price < 0 || min < 0) { toast('Цена и минимум не могут быть отрицательными', 'error'); return }
    onSubmit({
      name: f.name.trim(), category_id: f.category_id || null, sku: orNull(f.sku), manufacturer: orNull(f.manufacturer),
      supplier_id: f.supplier_id || null, url: orNull(f.url), unit: f.unit.trim() || 'шт', price, currency: f.currency,
      stock, min_stock: min, status: f.status, location: orNull(f.location), notes: f.notes,
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field label="Название"><input className="dash-input" required autoFocus maxLength={200} value={f.name} onChange={e => set('name')(e.target.value)} placeholder="Транзистор BLF188XR" /></Field>
      </div>
      <Field label="Категория">
        <select className="dash-input" value={f.category_id} onChange={e => set('category_id')(e.target.value)}>
          <option value="">Без категории</option>
          {cats.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Статус">
        <select className="dash-input" value={f.status} onChange={e => set('status')(e.target.value as Component['status'])}>
          {COMPONENT_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </Field>
      <Field label="Артикул"><input className="dash-input" value={f.sku} onChange={e => set('sku')(e.target.value)} /></Field>
      <Field label="Производитель"><input className="dash-input" value={f.manufacturer} onChange={e => set('manufacturer')(e.target.value)} placeholder="Ampleon" /></Field>
      <Field label="Поставщик">
        <select className="dash-input" value={f.supplier_id} onChange={e => set('supplier_id')(e.target.value)}>
          <option value="">Не указан</option>
          {sups.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Ссылка"><input className="dash-input" type="url" value={f.url} onChange={e => set('url')(e.target.value)} placeholder="https://" /></Field>
      <MoneyInput label="Закупочная цена за единицу" amount={f.price} currency={f.currency} onAmount={set('price')} onCurrency={set('currency')} />
      <Field label="Единица">
        <input className="dash-input" list="fl-units" maxLength={12} value={f.unit} onChange={e => set('unit')(e.target.value)} />
        <datalist id="fl-units">{UNITS.map(u => <option key={u} value={u} />)}</datalist>
      </Field>
      <Field label="На складе"><input className="dash-input" inputMode="decimal" value={f.stock} onChange={e => set('stock')(e.target.value)} /></Field>
      <Field label="Минимальный остаток" hint="Ниже — компонент попадёт в «Заказать»"><input className="dash-input" inputMode="decimal" value={f.min_stock} onChange={e => set('min_stock')(e.target.value)} /></Field>
      <div className="sm:col-span-2">
        <Field label="Место хранения"><input className="dash-input" value={f.location} onChange={e => set('location')(e.target.value)} placeholder="Стеллаж 2, ящик 14" /></Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Примечание"><textarea className="dash-input" value={f.notes} onChange={e => set('notes')(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        {onCancel && <button type="button" className="dash-btn dash-btn-ghost" onClick={onCancel}>Отмена</button>}
        <button className="dash-btn" disabled={busy || !f.name.trim()}>{busy ? 'Сохраняем…' : submitLabel}</button>
      </div>
    </form>
  )
}

// ── форма поставщика ────────────────────────────────────────────────────────

export const EMPTY_SUPPLIER: SupplierInput = { name: '', contact: null, website: null, telegram: null, phone: null, email: null, notes: '' }

export function SupplierForm({ initial, submitLabel, busy, onSubmit, onCancel }: {
  initial: SupplierInput; submitLabel: string; busy?: boolean
  onSubmit: (s: SupplierInput) => void; onCancel?: () => void
}) {
  const [f, setF] = useState({
    name: initial.name, contact: str(initial.contact), website: str(initial.website), telegram: str(initial.telegram),
    phone: str(initial.phone), email: str(initial.email), notes: initial.notes,
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit({
      name: f.name.trim(), contact: orNull(f.contact), website: orNull(f.website), telegram: orNull(f.telegram),
      phone: orNull(f.phone), email: orNull(f.email), notes: f.notes,
    })
  }
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Название"><input className="dash-input" required autoFocus maxLength={120} value={f.name} onChange={set('name')} placeholder="ЧИП и ДИП" /></Field></div>
      <Field label="Контактное лицо"><input className="dash-input" value={f.contact} onChange={set('contact')} /></Field>
      <Field label="Сайт"><input className="dash-input" type="url" value={f.website} onChange={set('website')} placeholder="https://" /></Field>
      <Field label="Telegram"><input className="dash-input" value={f.telegram} onChange={set('telegram')} placeholder="@username" /></Field>
      <Field label="Телефон"><input className="dash-input" type="tel" value={f.phone} onChange={set('phone')} /></Field>
      <div className="sm:col-span-2"><Field label="Email"><input className="dash-input" type="email" value={f.email} onChange={set('email')} /></Field></div>
      <div className="sm:col-span-2"><Field label="Заметки"><textarea className="dash-input" value={f.notes} onChange={set('notes')} /></Field></div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        {onCancel && <button type="button" className="dash-btn dash-btn-ghost" onClick={onCancel}>Отмена</button>}
        <button className="dash-btn" disabled={busy || !f.name.trim()}>{busy ? 'Сохраняем…' : submitLabel}</button>
      </div>
    </form>
  )
}

// ── редактор справочника ────────────────────────────────────────────────────

const PALETTE = ['#5ec4e6', '#5fd08f', '#f2b94b', '#e0a458', '#f06a6a', '#f08bb4', '#b49cf0', '#6ea8fe', '#a3b0bd', '#6b7785']

/** Список значений справочника: переименовать, перекрасить, добавить, удалить. */
export function DictEditor({ kind, title, open, onClose, usage }: {
  kind: DictKind; title: string; open: boolean; onClose: () => void
  /** сколько записей ссылается на значение — показываем перед удалением */
  usage?: (id: string) => number
}) {
  const { workspace } = useWorkspace()
  const list = useDicts(kind)
  const qc = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['dicts', workspace.id, kind] })
  const m = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: e => toast(errMsg(e), 'error'),
  })
  const items = list.data ?? []
  const add = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    m.mutate(() => createDict(workspace.id, kind, n, PALETTE[items.length % PALETTE.length], items.length + 1).then(() => setName('')))
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <ul className="mb-4 space-y-2">
        {items.map(d => (
          <li key={d.id} className="flex items-center gap-2">
            <input type="color" className="h-9 w-9 shrink-0 cursor-pointer rounded border border-[var(--d-line)] bg-transparent p-0.5"
              value={d.color} aria-label={`Цвет «${d.name}»`}
              onChange={e => m.mutate(() => updateDict(d.id, { color: e.target.value }))} />
            <input className="dash-input" defaultValue={d.name} aria-label="Название"
              onBlur={e => { const v = e.target.value.trim(); if (v && v !== d.name) m.mutate(() => updateDict(d.id, { name: v })) }} />
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" aria-label={`Удалить «${d.name}»`}
              onClick={() => {
                const n = usage?.(d.id) ?? 0
                if (confirm(n ? `«${d.name}» используется в ${n} записях — у них значение станет пустым. Удалить?` : `Удалить «${d.name}»?`)) {
                  m.mutate(() => deleteDict(d.id))
                }
              }}>
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="dash-muted text-sm">Пока пусто</li>}
      </ul>
      <form onSubmit={add} className="flex gap-2">
        <input className="dash-input" placeholder="Новое значение" maxLength={60} value={name} onChange={e => setName(e.target.value)} aria-label="Новое значение" />
        <button className="dash-btn shrink-0" disabled={!name.trim() || m.isPending}><Plus className="h-4 w-4" aria-hidden /> Добавить</button>
      </form>
    </Modal>
  )
}


// ── форма изделия ───────────────────────────────────────────────────────────

export const EMPTY_PRODUCT: ProductInput = {
  name: '', sku: null, version: null, status_id: null, description: '', specs: [],
  planned_price: null, actual_price: null, price_currency: 'RUB', notes: '',
}

const priceOrNull = (v: string) => (v.trim() ? parseAmount(v) : null)

export function ProductForm({ initial, submitLabel, busy, onSubmit, onCancel }: {
  initial: ProductInput; submitLabel: string; busy?: boolean
  onSubmit: (p: ProductInput) => void; onCancel?: () => void
}) {
  const statuses = useDicts('product_status')
  const toast = useToast()
  const [f, setF] = useState({
    name: initial.name, sku: str(initial.sku), version: str(initial.version), status_id: str(initial.status_id),
    description: initial.description, planned: initial.planned_price === null ? '' : String(initial.planned_price),
    actual: initial.actual_price === null ? '' : String(initial.actual_price), currency: initial.price_currency, notes: initial.notes,
  })
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const planned = priceOrNull(f.planned), actual = priceOrNull(f.actual)
    if ([planned, actual].some(v => v !== null && (!Number.isFinite(v) || v < 0))) { toast('Цены должны быть неотрицательными числами', 'error'); return }
    onSubmit({
      name: f.name.trim(), sku: orNull(f.sku), version: orNull(f.version), status_id: f.status_id || null,
      description: f.description, specs: initial.specs, planned_price: planned, actual_price: actual,
      price_currency: f.currency, notes: f.notes,
    })
  }
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Название"><input className="dash-input" required autoFocus maxLength={200} value={f.name} onChange={e => set('name')(e.target.value)} placeholder="Усилитель 100W УКВ" /></Field></div>
      <Field label="Внутренний артикул"><input className="dash-input dash-mono" value={f.sku} onChange={e => set('sku')(e.target.value)} placeholder="FL-AMP-100" /></Field>
      <Field label="Версия"><input className="dash-input" value={f.version} onChange={e => set('version')(e.target.value)} placeholder="v1.2" /></Field>
      <div className="sm:col-span-2">
        <Field label="Статус">
          <select className="dash-input" value={f.status_id} onChange={e => set('status_id')(e.target.value)}>
            <option value="">Без статуса</option>
            {statuses.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </div>
      <MoneyInput label="Плановая цена продажи" amount={f.planned} currency={f.currency} onAmount={set('planned')} onCurrency={set('currency')} />
      <MoneyInput label="Фактическая цена продажи" amount={f.actual} currency={f.currency} onAmount={set('actual')} onCurrency={set('currency')} />
      <div className="sm:col-span-2"><Field label="Описание"><textarea className="dash-input" value={f.description} onChange={e => set('description')(e.target.value)} placeholder="Назначение, диапазон, особенности" /></Field></div>
      <div className="sm:col-span-2"><Field label="Заметки"><textarea className="dash-input" value={f.notes} onChange={e => set('notes')(e.target.value)} /></Field></div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        {onCancel && <button type="button" className="dash-btn dash-btn-ghost" onClick={onCancel}>Отмена</button>}
        <button className="dash-btn" disabled={busy || !f.name.trim()}>{busy ? 'Сохраняем…' : submitLabel}</button>
      </div>
    </form>
  )
}

// ── характеристики ──────────────────────────────────────────────────────────

/** Таблица «параметр — значение — единица»: добавлять, править, двигать, удалять. */
export function SpecsEditor({ specs, busy, onSave, onCancel }: {
  specs: Spec[]; busy?: boolean; onSave: (s: Spec[]) => void; onCancel: () => void
}) {
  const [rows, setRows] = useState<Spec[]>(specs.length ? specs : [{ name: '', value: '', unit: '' }])
  const upd = (i: number, k: keyof Spec, v: string) => setRows(r => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  const move = (i: number, d: -1 | 1) => setRows(r => {
    const j = i + d
    if (j < 0 || j >= r.length) return r
    const n = [...r]
    const tmp = n[i]
    n[i] = n[j]
    n[j] = tmp
    return n
  })
  const save = (e: FormEvent) => {
    e.preventDefault()
    onSave(rows.map(r => ({ name: r.name.trim(), value: r.value.trim(), unit: r.unit?.trim() || undefined })).filter(r => r.name))
  }
  return (
    <form onSubmit={save}>
      <div className="dash-label mb-1.5 hidden grid-cols-[1.4fr_1fr_0.6fr_auto] gap-2 sm:grid"><span>Параметр</span><span>Значение</span><span>Ед.</span><span className="w-24" /></div>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="grid grid-cols-[1fr_5rem] gap-2 border-b border-[var(--d-line)] pb-2 sm:grid-cols-[1.4fr_1fr_0.6fr_auto] sm:border-0 sm:pb-0">
            <input className="dash-input col-span-2 sm:col-span-1" placeholder="Выходная мощность" value={r.name} onChange={e => upd(i, 'name', e.target.value)} aria-label="Параметр" />
            <input className="dash-input" placeholder="100" value={r.value} onChange={e => upd(i, 'value', e.target.value)} aria-label="Значение" />
            <input className="dash-input" placeholder="Вт" value={r.unit ?? ''} onChange={e => upd(i, 'unit', e.target.value)} aria-label="Единица" />
            <div className="col-span-2 flex justify-end gap-1 sm:col-span-1 sm:w-24">
              <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Выше"><ArrowUp className="h-3.5 w-3.5" aria-hidden /></button>
              <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Ниже"><ArrowDown className="h-3.5 w-3.5" aria-hidden /></button>
              <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setRows(x => x.filter((_, j) => j !== i))} aria-label="Удалить строку"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap justify-between gap-2">
        <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setRows(r => [...r, { name: '', value: '', unit: '' }])}><Plus className="h-4 w-4" aria-hidden /> Строка</button>
        <div className="flex gap-2">
          <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={onCancel}>Отмена</button>
          <button className="dash-btn dash-btn-sm" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        </div>
      </div>
    </form>
  )
}

// ── форма узла ──────────────────────────────────────────────────────────────

export const EMPTY_ASSEMBLY: AssemblyInput = { name: '', sku: null, description: '', cost_override: null, notes: '' }

export function AssemblyForm({ initial, submitLabel, busy, onSubmit, onCancel }: {
  initial: AssemblyInput; submitLabel: string; busy?: boolean
  onSubmit: (a: AssemblyInput) => void; onCancel?: () => void
}) {
  const toast = useToast()
  const [f, setF] = useState({
    name: initial.name, sku: str(initial.sku), description: initial.description, notes: initial.notes,
    override: initial.cost_override === null ? '' : String(initial.cost_override),
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const o = f.override.trim() ? parseAmount(f.override) : null
    if (o !== null && (!Number.isFinite(o) || o < 0)) { toast('Ручная стоимость должна быть неотрицательным числом', 'error'); return }
    onSubmit({ name: f.name.trim(), sku: orNull(f.sku), description: f.description, notes: f.notes, cost_override: o })
  }
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Название"><input className="dash-input" required autoFocus maxLength={200} value={f.name} onChange={set('name')} placeholder="Выходной каскад 100W" /></Field></div>
      <Field label="Артикул"><input className="dash-input dash-mono" value={f.sku} onChange={set('sku')} placeholder="FL-ASM-PA100" /></Field>
      <Field label="Ручная стоимость, ₽" hint="Для покупного модуля или уточнённой оценки. Пусто — считается по составу">
        <input className="dash-input" inputMode="decimal" value={f.override} onChange={set('override')} placeholder="по составу" />
      </Field>
      <div className="sm:col-span-2"><Field label="Описание"><textarea className="dash-input" value={f.description} onChange={set('description')} /></Field></div>
      <div className="sm:col-span-2"><Field label="Заметки"><textarea className="dash-input" value={f.notes} onChange={set('notes')} /></Field></div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        {onCancel && <button type="button" className="dash-btn dash-btn-ghost" onClick={onCancel}>Отмена</button>}
        <button className="dash-btn" disabled={busy || !f.name.trim()}>{busy ? 'Сохраняем…' : submitLabel}</button>
      </div>
    </form>
  )
}

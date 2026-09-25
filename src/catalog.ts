// Данные производства: курсы, справочники, поставщики, компоненты.
import { supabase } from './supabase'
import type { Currency, Rate } from './money'
import type { BomItem } from './costing'

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

/** RLS молча отсекает недоступные строки: 0 строк — отказ, а не успех. */
function one(rows: unknown[], what: string) {
  if (!rows.length) throw new Error(`${what}: нет доступа или запись удалена`)
}

// ── курсы ───────────────────────────────────────────────────────────────────

export async function fetchRates() {
  const rows = check(await supabase.from('fl_rates').select('*').order('currency')) as Rate[]
  return rows.map(r => ({
    ...r,
    cbr_rate: r.cbr_rate === null ? null : Number(r.cbr_rate),
    manual_rate: r.manual_rate === null ? null : Number(r.manual_rate),
  }))
}

export async function setManualRate(currency: Currency, rate: number | null) {
  one(check(await supabase.from('fl_rates').update({ manual_rate: rate }).eq('currency', currency).select('currency')), 'Курс')
}

const CBR_URL = 'https://www.cbr-xml-daily.ru/daily_json.js'

/**
 * Курс ЦБ берёт браузер: источник отвечает российским адресам и не отвечает
 * серверам Supabase. Не вышло — просим базу (она попробует ЦБ, затем рыночный).
 */
export async function refreshRates(): Promise<'cbr' | 'server'> {
  try {
    const r = await fetch(CBR_URL, { cache: 'no-store' })
    if (!r.ok) throw new Error(String(r.status))
    const j = await r.json() as { Date: string; Valute: Record<string, { Nominal: number; Value: number }> }
    const rates: Record<string, number> = {}
    for (const c of ['USD', 'CNY', 'EUR']) {
      const v = j.Valute?.[c]
      if (v?.Nominal && v.Value) rates[c] = v.Value / v.Nominal
    }
    check(await supabase.rpc('fl_set_cbr_rates', { p_date: j.Date.slice(0, 10), p_rates: rates }))
    return 'cbr'
  } catch {
    check(await supabase.rpc('fl_refresh_rates', { p_force: true }))
    return 'server'
  }
}

// ── справочники ─────────────────────────────────────────────────────────────

export type DictKind = 'component_category' | 'expense_category' | 'product_status'

export interface Dict {
  id: string
  workspace_id: string
  kind: DictKind
  name: string
  color: string
  position: number
}

export async function fetchDicts(workspaceId: string, kind: DictKind) {
  return check(await supabase.from('fl_dicts').select('*')
    .eq('workspace_id', workspaceId).eq('kind', kind).order('position').order('name')) as Dict[]
}

export async function createDict(workspaceId: string, kind: DictKind, name: string, color: string, position: number) {
  return check(await supabase.from('fl_dicts')
    .insert({ workspace_id: workspaceId, kind, name, color, position }).select().single()) as Dict
}

export async function updateDict(id: string, patch: Partial<Pick<Dict, 'name' | 'color' | 'position'>>) {
  one(check(await supabase.from('fl_dicts').update(patch).eq('id', id).select('id')), 'Запись справочника')
}

export async function deleteDict(id: string) {
  one(check(await supabase.from('fl_dicts').delete().eq('id', id).select('id')), 'Запись справочника')
}

// ── поставщики ──────────────────────────────────────────────────────────────

export interface Supplier {
  id: string
  workspace_id: string
  name: string
  contact: string | null
  website: string | null
  telegram: string | null
  phone: string | null
  email: string | null
  notes: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type SupplierInput = Pick<Supplier, 'name' | 'contact' | 'website' | 'telegram' | 'phone' | 'email' | 'notes'>

export async function fetchSuppliers(workspaceId: string, archived = false) {
  let q = supabase.from('fl_suppliers').select('*').eq('workspace_id', workspaceId).order('name')
  q = archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  return check(await q) as Supplier[]
}

export async function fetchSupplier(id: string) {
  return check(await supabase.from('fl_suppliers').select('*').eq('id', id).maybeSingle()) as Supplier | null
}

export async function createSupplier(workspaceId: string, s: SupplierInput) {
  return check(await supabase.from('fl_suppliers').insert({ workspace_id: workspaceId, ...s }).select().single()) as Supplier
}

export async function updateSupplier(id: string, patch: Partial<SupplierInput & { archived_at: string | null }>) {
  one(check(await supabase.from('fl_suppliers').update(patch).eq('id', id).select('id')), 'Поставщик')
}

/** Строки файлов уходят каскадом, а сами объекты в бакете — только вручную. */
async function deleteWithFiles(table: 'fl_components' | 'fl_suppliers', column: 'component_id' | 'supplier_id', id: string, what: string) {
  const atts = check(await supabase.from('ws_attachments').select('storage_path').eq(column, id)) as { storage_path: string }[]
  one(check(await supabase.from(table).delete().eq('id', id).select('id')), what)
  if (atts.length) await supabase.storage.from('ws-files').remove(atts.map(a => a.storage_path))
}

export const deleteSupplier = (id: string) => deleteWithFiles('fl_suppliers', 'supplier_id', id, 'Поставщик')

// ── компоненты ──────────────────────────────────────────────────────────────

export type ComponentStatus = 'active' | 'ordered' | 'obsolete'

export interface Component {
  id: string
  workspace_id: string
  name: string
  category_id: string | null
  sku: string | null
  manufacturer: string | null
  supplier_id: string | null
  url: string | null
  unit: string
  price: number
  currency: Currency
  stock: number
  min_stock: number
  status: ComponentStatus
  location: string | null
  notes: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type ComponentInput = Pick<Component,
  'name' | 'category_id' | 'sku' | 'manufacturer' | 'supplier_id' | 'url' | 'unit' | 'price' | 'currency'
  | 'stock' | 'min_stock' | 'status' | 'location' | 'notes'>

// numeric из PostgREST приходит строкой, если не влезает в double без потерь
const num = (c: Component): Component => ({ ...c, price: Number(c.price), stock: Number(c.stock), min_stock: Number(c.min_stock) })

export async function fetchComponents(workspaceId: string, opts: { archived?: boolean; supplierId?: string } = {}) {
  let q = supabase.from('fl_components').select('*').eq('workspace_id', workspaceId).order('name')
  q = opts.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  if (opts.supplierId) q = q.eq('supplier_id', opts.supplierId)
  return (check(await q) as Component[]).map(num)
}

export async function fetchComponent(id: string) {
  const c = check(await supabase.from('fl_components').select('*').eq('id', id).maybeSingle()) as Component | null
  return c ? num(c) : null
}

export async function createComponent(workspaceId: string, c: ComponentInput) {
  return num(check(await supabase.from('fl_components').insert({ workspace_id: workspaceId, ...c }).select().single()) as Component)
}

export async function updateComponent(id: string, patch: Partial<ComponentInput & { archived_at: string | null }>) {
  one(check(await supabase.from('fl_components').update(patch).eq('id', id).select('id')), 'Компонент')
}

export const deleteComponent = (id: string) => deleteWithFiles('fl_components', 'component_id', id, 'Компонент')

export const COMPONENT_STATUSES: { id: ComponentStatus; label: string; color: string }[] = [
  { id: 'active', label: 'В ходу', color: '#5fd08f' },
  { id: 'ordered', label: 'Заказан', color: '#5ec4e6' },
  { id: 'obsolete', label: 'Не используется', color: '#6b7785' },
]

export const UNITS = ['шт', 'м', 'кг', 'г', 'л', 'компл', 'уп', 'м²']

/** Пора заказывать: остаток дошёл до минимума (минимум задан, компонент в ходу). */
export const needsReorder = (c: Pick<Component, 'stock' | 'min_stock' | 'status'>) =>
  c.status !== 'obsolete' && c.min_stock > 0 && c.stock <= c.min_stock

// ── изделия ─────────────────────────────────────────────────────────────────

export interface Spec { name: string; value: string; unit?: string }

export interface Product {
  id: string
  workspace_id: string
  name: string
  sku: string | null
  version: string | null
  status_id: string | null
  description: string
  specs: Spec[]
  planned_price: number | null
  actual_price: number | null
  price_currency: Currency
  notes: string
  manufacturing_cost: number
  additional_cost: number
  overhead_pct: number
  cost_override: number | null
  planned_qty: number
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type ProductInput = Pick<Product,
  'name' | 'sku' | 'version' | 'status_id' | 'description' | 'specs' | 'planned_price' | 'actual_price' | 'price_currency' | 'notes'>

const numOrNull = (v: number | string | null) => (v === null ? null : Number(v))
const prod = (p: Product): Product => ({
  ...p, planned_price: numOrNull(p.planned_price), actual_price: numOrNull(p.actual_price),
  manufacturing_cost: Number(p.manufacturing_cost ?? 0), additional_cost: Number(p.additional_cost ?? 0),
  overhead_pct: Number(p.overhead_pct ?? 0), cost_override: numOrNull(p.cost_override ?? null), planned_qty: Number(p.planned_qty ?? 0),
})

export async function fetchProducts(workspaceId: string, archived = false) {
  let q = supabase.from('fl_products').select('*').eq('workspace_id', workspaceId).order('name')
  q = archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  return (check(await q) as Product[]).map(prod)
}

export async function fetchProduct(id: string) {
  const p = check(await supabase.from('fl_products').select('*').eq('id', id).maybeSingle()) as Product | null
  return p ? prod(p) : null
}

export async function createProduct(workspaceId: string, p: ProductInput) {
  return prod(check(await supabase.from('fl_products').insert({ workspace_id: workspaceId, ...p }).select().single()) as Product)
}

export type ProductCostPatch = Partial<Pick<Product, 'manufacturing_cost' | 'additional_cost' | 'overhead_pct' | 'cost_override' | 'planned_qty'>>

export async function updateProduct(id: string, patch: Partial<ProductInput & { archived_at: string | null }> & ProductCostPatch) {
  one(check(await supabase.from('fl_products').update(patch).eq('id', id).select('id')), 'Изделие')
}

export async function deleteProduct(id: string) {
  const atts = check(await supabase.from('ws_attachments').select('storage_path').eq('product_id', id)) as { storage_path: string }[]
  one(check(await supabase.from('fl_products').delete().eq('id', id).select('id')), 'Изделие')
  if (atts.length) await supabase.storage.from('ws-files').remove(atts.map(a => a.storage_path))
}

/** Цена продажи для расчётов: фактическая, если есть, иначе плановая. */
export const sellingPrice = (p: Pick<Product, 'planned_price' | 'actual_price'>) => p.actual_price ?? p.planned_price

// ── узлы ────────────────────────────────────────────────────────────────────

export interface Assembly {
  id: string
  workspace_id: string
  name: string
  sku: string | null
  description: string
  cost_override: number | null
  notes: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type AssemblyInput = Pick<Assembly, 'name' | 'sku' | 'description' | 'cost_override' | 'notes'>

const asm = (a: Assembly): Assembly => ({ ...a, cost_override: a.cost_override === null ? null : Number(a.cost_override) })

/** Все узлы, включая архивные: архивный узел может стоять в чьём-то составе. */
export async function fetchAssemblies(workspaceId: string) {
  return (check(await supabase.from('fl_assemblies').select('*').eq('workspace_id', workspaceId).order('name')) as Assembly[]).map(asm)
}

export async function fetchAssembly(id: string) {
  const a = check(await supabase.from('fl_assemblies').select('*').eq('id', id).maybeSingle()) as Assembly | null
  return a ? asm(a) : null
}

export async function createAssembly(workspaceId: string, a: AssemblyInput) {
  return asm(check(await supabase.from('fl_assemblies').insert({ workspace_id: workspaceId, ...a }).select().single()) as Assembly)
}

export async function updateAssembly(id: string, patch: Partial<AssemblyInput & { archived_at: string | null }>) {
  one(check(await supabase.from('fl_assemblies').update(patch).eq('id', id).select('id')), 'Узел')
}

export async function deleteAssembly(id: string) {
  const atts = check(await supabase.from('ws_attachments').select('storage_path').eq('assembly_id', id)) as { storage_path: string }[]
  one(check(await supabase.from('fl_assemblies').delete().eq('id', id).select('id')), 'Узел')
  if (atts.length) await supabase.storage.from('ws-files').remove(atts.map(a => a.storage_path))
}

// ── BOM ─────────────────────────────────────────────────────────────────────

const bom = (b: BomItem): BomItem => ({
  ...b, qty: Number(b.qty), price_override: b.price_override === null ? null : Number(b.price_override),
})

export async function fetchBomItems(workspaceId: string) {
  return (check(await supabase.from('fl_bom_items').select('*').eq('workspace_id', workspaceId)
    .order('position').order('created_at')) as BomItem[]).map(bom)
}

export interface NewBomItem {
  parent_product_id?: string
  parent_assembly_id?: string
  component_id?: string
  child_assembly_id?: string
  qty: number
  position: number
}

export async function addBomItem(workspaceId: string, it: NewBomItem) {
  const res = await supabase.from('fl_bom_items').insert({ workspace_id: workspaceId, ...it }).select().single()
  if (res.error?.code === '23505') throw new Error('Эта позиция уже есть в составе — измените количество в строке')
  return bom(check(res) as BomItem)
}

export type BomPatch = Partial<Pick<BomItem, 'qty' | 'price_override' | 'price_currency' | 'note' | 'position'>>

export async function updateBomItem(id: string, patch: BomPatch) {
  one(check(await supabase.from('fl_bom_items').update(patch).eq('id', id).select('id')), 'Строка состава')
}

export async function deleteBomItem(id: string) {
  one(check(await supabase.from('fl_bom_items').delete().eq('id', id).select('id')), 'Строка состава')
}

/** Все компоненты, включая архивные: для расчёта состава. */
export async function fetchAllComponents(workspaceId: string) {
  return (check(await supabase.from('fl_components').select('*').eq('workspace_id', workspaceId).order('name')) as Component[]).map(num)
}

// ── расходы ─────────────────────────────────────────────────────────────────

export interface Expense {
  id: string
  workspace_id: string
  spent_on: string
  category_id: string | null
  description: string
  amount: number
  currency: Currency
  rate_rub: number
  amount_rub: number
  supplier_id: string | null
  product_id: string | null
  component_id: string | null
  note: string
  source: 'dashboard' | 'telegram'
  created_by: string | null
  created_at: string
}

export type ExpenseInput = Pick<Expense,
  'spent_on' | 'category_id' | 'description' | 'amount' | 'currency' | 'rate_rub' | 'supplier_id' | 'product_id' | 'component_id' | 'note'>

const exp = (e: Expense): Expense => ({ ...e, amount: Number(e.amount), rate_rub: Number(e.rate_rub), amount_rub: Number(e.amount_rub) })

export async function fetchExpenses(workspaceId: string, opts: { supplierId?: string; productId?: string; componentId?: string } = {}) {
  let q = supabase.from('fl_expenses').select('*').eq('workspace_id', workspaceId)
    .order('spent_on', { ascending: false }).order('created_at', { ascending: false }).limit(2000)
  if (opts.supplierId) q = q.eq('supplier_id', opts.supplierId)
  if (opts.productId) q = q.eq('product_id', opts.productId)
  if (opts.componentId) q = q.eq('component_id', opts.componentId)
  return (check(await q) as Expense[]).map(exp)
}

export async function createExpense(workspaceId: string, e: ExpenseInput) {
  return exp(check(await supabase.from('fl_expenses').insert({ workspace_id: workspaceId, ...e }).select().single()) as Expense)
}

export async function updateExpense(id: string, patch: Partial<ExpenseInput>) {
  one(check(await supabase.from('fl_expenses').update(patch).eq('id', id).select('id')), 'Расход')
}

export async function deleteExpense(id: string) {
  const atts = check(await supabase.from('ws_attachments').select('storage_path').eq('expense_id', id)) as { storage_path: string }[]
  one(check(await supabase.from('fl_expenses').delete().eq('id', id).select('id')), 'Расход')
  if (atts.length) await supabase.storage.from('ws-files').remove(atts.map(a => a.storage_path))
}

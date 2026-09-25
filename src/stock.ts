// Склад в работе: сборки, заказы поставщикам, предложения поставщиков.
import { supabase } from './supabase'
import type { Currency } from './money'
import type { Measurement, RevLine, TestResult } from './quality'

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}
const one = (rows: unknown[], what: string) => { if (!rows.length) throw new Error(`${what}: нет доступа или запись удалена`) }

// ── сборки ──────────────────────────────────────────────────────────────────

export interface BuildLine { component_id: string; name: string; unit: string; qty: number }
export interface Build {
  id: string
  workspace_id: string
  product_id: string | null
  assembly_id: string | null
  title: string
  qty: number
  note: string
  lines: BuildLine[]
  created_by: string | null
  created_at: string
  reverted_at: string | null
}

export async function fetchBuilds(target: { productId?: string; assemblyId?: string }) {
  let q = supabase.from('fl_builds').select('*').order('created_at', { ascending: false }).limit(20)
  if (target.productId) q = q.eq('product_id', target.productId)
  if (target.assemblyId) q = q.eq('assembly_id', target.assemblyId)
  return (check(await q) as Build[]).map(b => ({ ...b, qty: Number(b.qty), lines: b.lines.map(l => ({ ...l, qty: Number(l.qty) })) }))
}

export async function build(target: { productId?: string; assemblyId?: string }, qty: number, note: string) {
  return check(await supabase.rpc('fl_build', {
    p_product: target.productId ?? null, p_assembly: target.assemblyId ?? null, p_qty: qty, p_note: note,
  })) as string
}

export async function revertBuild(id: string) {
  check(await supabase.rpc('fl_build_revert', { p_build: id }))
}

// ── предложения поставщиков ─────────────────────────────────────────────────

export interface Offer {
  id: string
  component_id: string
  supplier_id: string
  price: number
  currency: Currency
  sku: string | null
  url: string | null
  lead_time: string | null
  note: string
  updated_at: string
}
export type OfferInput = Pick<Offer, 'supplier_id' | 'price' | 'currency' | 'sku' | 'url' | 'lead_time' | 'note'>

export async function fetchOffers(componentId: string) {
  return (check(await supabase.from('fl_component_offers').select('*').eq('component_id', componentId)) as Offer[])
    .map(o => ({ ...o, price: Number(o.price) }))
}

export async function saveOffer(componentId: string, o: OfferInput, id?: string) {
  if (id) one(check(await supabase.from('fl_component_offers').update(o).eq('id', id).select('id')), 'Предложение')
  else check(await supabase.from('fl_component_offers').insert({ component_id: componentId, ...o }).select('id'))
}

export async function deleteOffer(id: string) {
  one(check(await supabase.from('fl_component_offers').delete().eq('id', id).select('id')), 'Предложение')
}

// ── заказы поставщикам ──────────────────────────────────────────────────────

export type OrderStatus = 'draft' | 'ordered' | 'received' | 'cancelled'

export const ORDER_STATUSES: { id: OrderStatus; label: string; color: string }[] = [
  { id: 'draft', label: 'Черновик', color: '#a3b0bd' },
  { id: 'ordered', label: 'Заказан', color: '#5ec4e6' },
  { id: 'received', label: 'Принят', color: '#5fd08f' },
  { id: 'cancelled', label: 'Отменён', color: '#6b7785' },
]

export interface OrderItem {
  id: string
  order_id: string
  component_id: string | null
  name: string
  unit: string
  qty: number
  price: number
  currency: Currency
  received_qty: number | null
  position: number
}

export interface PurchaseOrder {
  id: string
  workspace_id: string
  num: number
  supplier_id: string | null
  status: OrderStatus
  expected_on: string | null
  note: string
  expense_id: string | null
  created_by: string | null
  created_at: string
  ordered_at: string | null
  received_at: string | null
  items: OrderItem[]
}

const numItem = (i: OrderItem): OrderItem => ({
  ...i, qty: Number(i.qty), price: Number(i.price), received_qty: i.received_qty === null ? null : Number(i.received_qty),
})

export async function fetchOrders(workspaceId: string) {
  const rows = check(await supabase.from('fl_purchase_orders').select('*, items:fl_purchase_order_items(*)')
    .eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(300)) as PurchaseOrder[]
  return rows.map(o => ({ ...o, items: o.items.map(numItem).sort((a, b) => a.position - b.position) }))
}

export async function fetchOrder(id: string) {
  const o = check(await supabase.from('fl_purchase_orders').select('*, items:fl_purchase_order_items(*)').eq('id', id).maybeSingle()) as PurchaseOrder | null
  return o ? { ...o, items: o.items.map(numItem).sort((a, b) => a.position - b.position) } : null
}

export interface NewOrderLine { component_id: string; qty: number; price?: number; currency?: Currency }

export async function createOrder(workspaceId: string, supplierId: string | null, lines: NewOrderLine[], note = '', expected: string | null = null) {
  return check(await supabase.rpc('fl_po_create', {
    p_ws: workspaceId, p_supplier: supplierId, p_items: lines, p_note: note, p_expected: expected,
  })) as string
}

export async function setOrderStatus(id: string, status: 'draft' | 'ordered' | 'cancelled') {
  check(await supabase.rpc('fl_po_set_status', { p_order: id, p_status: status }))
}

export async function updateOrder(id: string, patch: Partial<Pick<PurchaseOrder, 'supplier_id' | 'expected_on' | 'note'>>) {
  one(check(await supabase.from('fl_purchase_orders').update(patch).eq('id', id).select('id')), 'Заказ')
}

export async function updateOrderItem(id: string, patch: Partial<Pick<OrderItem, 'qty' | 'price' | 'currency'>>) {
  one(check(await supabase.from('fl_purchase_order_items').update(patch).eq('id', id).select('id')), 'Строка заказа (менять можно только черновик)')
}

export async function deleteOrderItem(id: string) {
  one(check(await supabase.from('fl_purchase_order_items').delete().eq('id', id).select('id')), 'Строка заказа (менять можно только черновик)')
}

export async function deleteOrder(id: string) {
  one(check(await supabase.from('fl_purchase_orders').delete().eq('id', id).select('id')), 'Заказ (удалить можно черновик или отменённый)')
}

export async function receiveOrder(id: string, lines: { item_id: string; qty: number }[] | null, updatePrices: boolean, expense: boolean) {
  return check(await supabase.rpc('fl_po_receive', {
    p_order: id, p_lines: lines, p_update_prices: updatePrices, p_expense: expense,
  })) as string | null
}

export async function searchOrders(workspaceId: string, q: string) {
  return check(await supabase.rpc('fl_search_orders', { p_ws: workspaceId, p_q: q })) as
    { id: string; num: number; status: OrderStatus; supplier: string | null }[]
}

// ── испытания ───────────────────────────────────────────────────────────────


export interface ProductTest {
  id: string
  product_id: string
  serial: string | null
  tested_on: string
  tester_id: string | null
  measurements: Measurement[]
  result: TestResult
  note: string
  created_at: string
}
export type TestInput = Pick<ProductTest, 'serial' | 'tested_on' | 'measurements' | 'note'>

export async function fetchTests(productId: string) {
  return check(await supabase.from('fl_tests').select('*').eq('product_id', productId)
    .order('tested_on', { ascending: false }).order('created_at', { ascending: false }).limit(200)) as ProductTest[]
}

export async function saveTest(productId: string, t: TestInput, id?: string) {
  if (id) one(check(await supabase.from('fl_tests').update(t).eq('id', id).select('id')), 'Испытание')
  else check(await supabase.from('fl_tests').insert({ product_id: productId, ...t }).select('id'))
}

export async function deleteTest(id: string) {
  one(check(await supabase.from('fl_tests').delete().eq('id', id).select('id')), 'Испытание')
}

// ── ревизии состава ─────────────────────────────────────────────────────────

export interface BomRevision {
  id: string
  product_id: string | null
  assembly_id: string | null
  label: string
  note: string
  lines: RevLine[]
  total_rub: number
  created_by: string | null
  created_at: string
}

export async function fetchRevisions(target: { productId?: string; assemblyId?: string }) {
  let q = supabase.from('fl_bom_revisions').select('*').order('created_at', { ascending: false }).limit(50)
  if (target.productId) q = q.eq('product_id', target.productId)
  if (target.assemblyId) q = q.eq('assembly_id', target.assemblyId)
  return (check(await q) as BomRevision[]).map(r => ({ ...r, total_rub: Number(r.total_rub) }))
}

export async function createRevision(target: { productId?: string; assemblyId?: string }, label: string, note: string, lines: RevLine[], total: number) {
  check(await supabase.from('fl_bom_revisions').insert({
    product_id: target.productId ?? null, assembly_id: target.assemblyId ?? null, label, note, lines, total_rub: Math.round(total * 100) / 100,
  }).select('id'))
}

export async function deleteRevision(id: string) {
  one(check(await supabase.from('fl_bom_revisions').delete().eq('id', id).select('id')), 'Ревизия')
}

// ── инвентаризация ──────────────────────────────────────────────────────────

export interface Stocktake {
  id: string
  workspace_id: string
  num: number
  title: string
  status: 'draft' | 'applied' | 'cancelled'
  created_by: string | null
  created_at: string
  applied_at: string | null
  applied_by: string | null
  lines?: { counted: number | null }[]
}
export interface StocktakeLine {
  id: string
  stocktake_id: string
  component_id: string
  name: string
  sku: string | null
  unit: string
  location: string | null
  expected: number
  counted: number | null
  applied_delta: number | null
}

export async function fetchStocktakes(workspaceId: string) {
  return check(await supabase.from('fl_stocktakes').select('*, lines:fl_stocktake_lines(counted)')
    .eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(100)) as Stocktake[]
}

export async function fetchStocktake(id: string) {
  const s = check(await supabase.from('fl_stocktakes').select('*').eq('id', id).maybeSingle()) as Stocktake | null
  if (!s) return null
  const lines = check(await supabase.from('fl_stocktake_lines').select('*').eq('stocktake_id', id).limit(2000)) as StocktakeLine[]
  const n = (v: number | null) => (v === null ? null : Number(v))
  return { ...s, lines: lines.map(l => ({ ...l, expected: Number(l.expected), counted: n(l.counted), applied_delta: n(l.applied_delta) })) }
}

export async function startStocktake(workspaceId: string, o: { category?: string; location?: string; title?: string }) {
  return check(await supabase.rpc('fl_stocktake_start', {
    p_ws: workspaceId, p_category: o.category || null, p_location: o.location?.trim() || null, p_title: o.title?.trim() ?? '',
  })) as string
}

export async function setCounted(lineId: string, value: number | null) {
  one(check(await supabase.from('fl_stocktake_lines').update({ counted: value }).eq('id', lineId).select('id')), 'Строка (инвентаризация уже закрыта?)')
}

export async function applyStocktake(id: string) {
  return check(await supabase.rpc('fl_stocktake_apply', { p_id: id })) as { changed: number; same: number; moved: number }
}

export async function cancelStocktake(id: string) {
  one(check(await supabase.from('fl_stocktakes').update({ status: 'cancelled' }).eq('id', id).select('id')), 'Инвентаризация')
}

export async function deleteStocktake(id: string) {
  one(check(await supabase.from('fl_stocktakes').delete().eq('id', id).select('id')), 'Инвентаризация (применённую удалить нельзя)')
}

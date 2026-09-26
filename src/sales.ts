// Заказы клиентов: API.
import { supabase } from './supabase'
import type { Currency } from './money'
import type { SaleStatus } from './saleMath'

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}
const one = (rows: unknown[], what: string) => { if (!rows.length) throw new Error(`${what}: нет доступа или запись удалена`) }

export interface SaleItem { id: string; order_id: string; product_id: string | null; name: string; qty: number; price: number; position: number }
export interface Sale {
  id: string
  workspace_id: string
  num: number
  customer: string
  contact: string
  status: SaleStatus
  currency: Currency
  due_on: string | null
  note: string
  paid: number
  created_by: string | null
  created_at: string
  items: SaleItem[]
}

const norm = (o: Sale): Sale => ({
  ...o, paid: Number(o.paid),
  items: (o.items ?? []).map(i => ({ ...i, qty: Number(i.qty), price: Number(i.price) })).sort((a, b) => a.position - b.position),
})

export async function fetchSales(workspaceId: string) {
  return (check(await supabase.from('fl_customer_orders').select('*, items:fl_customer_order_items(*)')
    .eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(300)) as Sale[]).map(norm)
}

export async function fetchSale(id: string) {
  const o = check(await supabase.from('fl_customer_orders').select('*, items:fl_customer_order_items(*)').eq('id', id).maybeSingle()) as Sale | null
  return o ? norm(o) : null
}

export interface NewSaleInput {
  customer: string; contact: string; currency: Currency; due: string | null; note: string
  items: { product_id: string; qty: number; price?: number }[]
}

export async function createSale(workspaceId: string, s: NewSaleInput) {
  return check(await supabase.rpc('fl_co_create', {
    p_ws: workspaceId, p_customer: s.customer, p_contact: s.contact, p_currency: s.currency, p_due: s.due, p_note: s.note, p_items: s.items,
  })) as string
}

export async function updateSale(id: string, patch: Partial<Pick<Sale, 'customer' | 'contact' | 'status' | 'currency' | 'due_on' | 'note' | 'paid'>>) {
  one(check(await supabase.from('fl_customer_orders').update(patch).eq('id', id).select('id')), 'Заказ')
}

export async function updateSaleItem(id: string, patch: Partial<Pick<SaleItem, 'qty' | 'price'>>) {
  one(check(await supabase.from('fl_customer_order_items').update(patch).eq('id', id).select('id')), 'Позиция (менять можно только новый заказ)')
}

export async function addSaleItem(orderId: string, productId: string, name: string, qty: number, price: number, position: number) {
  check(await supabase.from('fl_customer_order_items').insert({ order_id: orderId, product_id: productId, name, qty, price, position }).select('id'))
}

export async function deleteSaleItem(id: string) {
  one(check(await supabase.from('fl_customer_order_items').delete().eq('id', id).select('id')), 'Позиция (менять можно только новый заказ)')
}

export async function deleteSale(id: string) {
  one(check(await supabase.from('fl_customer_orders').delete().eq('id', id).select('id')), 'Заказ (удалить можно новый или отменённый)')
}

/** Экземпляры, отгруженные по этому заказу. */
export async function fetchSaleUnits(orderId: string) {
  return check(await supabase.from('fl_units').select('id, serial, product_id, status, shipped_on').eq('order_id', orderId).limit(500)) as
    { id: string; serial: string; product_id: string; status: string; shipped_on: string | null }[]
}

/** Заказы, к которым ещё можно привязать отгрузку. */
export async function fetchOpenSales(workspaceId: string) {
  return check(await supabase.from('fl_customer_orders').select('id, num, customer').eq('workspace_id', workspaceId)
    .in('status', ['new', 'in_progress', 'ready']).order('num', { ascending: false }).limit(100)) as { id: string; num: number; customer: string }[]
}

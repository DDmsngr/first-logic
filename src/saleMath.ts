// Заказы клиентов: суммы, оплата, выручка и маржа. Чистые функции.

export type SaleStatus = 'new' | 'in_progress' | 'ready' | 'shipped' | 'cancelled'

export const SALE_STATUSES: { id: SaleStatus; label: string; color: string }[] = [
  { id: 'new', label: 'Новый', color: '#a3b0bd' },
  { id: 'in_progress', label: 'В работе', color: '#5ec4e6' },
  { id: 'ready', label: 'Готов', color: '#b49cf0' },
  { id: 'shipped', label: 'Отгружен', color: '#5fd08f' },
  { id: 'cancelled', label: 'Отменён', color: '#6b7785' },
]

/** Следующий шаг цепочки для кнопки «→». Отменённый и отгруженный — конец. */
export const NEXT_STATUS: Partial<Record<SaleStatus, SaleStatus>> = { new: 'in_progress', in_progress: 'ready', ready: 'shipped' }

export interface SaleLine { qty: number; price: number }

export const saleTotal = (lines: SaleLine[]) => Math.round(lines.reduce((s, l) => s + l.qty * l.price, 0) * 100) / 100

export type PaymentState = 'unpaid' | 'partial' | 'paid' | 'over'

/** Оплата по заказу: сколько ещё должны и в каком состоянии. Сумма 0 — оплаты не требуется. */
export function paymentState(total: number, paid: number): { state: PaymentState; due: number } {
  const due = Math.round((total - paid) * 100) / 100
  if (total <= 0) return { state: paid > 0 ? 'over' : 'paid', due: 0 }
  if (paid <= 0) return { state: 'unpaid', due }
  if (due > 0) return { state: 'partial', due }
  return { state: due < 0 ? 'over' : 'paid', due: 0 }
}

export const PAYMENT_LABEL: Record<PaymentState, string> = { unpaid: 'Не оплачен', partial: 'Оплачен частично', paid: 'Оплачен', over: 'Переплата' }

/**
 * Маржа заказа: выручка минус расчётная себестоимость позиций.
 * costs — себестоимость штуки в рублях по позиции (null — изделие удалено или без состава).
 * Позиции без себестоимости в маржу не входят, о них говорит missing.
 */
export function saleMargin(revenueRub: number, lines: { qty: number; unitCostRub: number | null; revenueRub: number }[]) {
  const known = lines.filter(l => l.unitCostRub !== null)
  const cost = known.reduce((s, l) => s + l.qty * l.unitCostRub!, 0)
  const revenueKnown = known.reduce((s, l) => s + l.revenueRub, 0)
  const profit = revenueKnown - cost
  return {
    cost: Math.round(cost * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    margin: revenueKnown > 0 ? (profit / revenueKnown) * 100 : null,
    missing: lines.length - known.length,
    revenueRub,
  }
}

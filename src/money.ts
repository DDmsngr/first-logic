// Деньги и валюты. Чистые функции без React и Supabase: их же будет
// использовать расчёт себестоимости и Telegram-бот.

export type Currency = 'RUB' | 'USD' | 'CNY' | 'EUR'

export const CURRENCIES: { id: Currency; label: string; sign: string }[] = [
  { id: 'RUB', label: 'Рубль', sign: '₽' },
  { id: 'USD', label: 'Доллар США', sign: '$' },
  { id: 'CNY', label: 'Юань', sign: '¥' },
  { id: 'EUR', label: 'Евро', sign: '€' },
]

export interface Rate {
  currency: Exclude<Currency, 'RUB'>
  cbr_rate: number | null
  cbr_date: string | null
  fetched_at: string | null
  manual_rate: number | null
  updated_at: string
  /** cbr — курс ЦБ РФ; market — рыночный (запасной источник) */
  source?: 'cbr' | 'market'
}

/** Рублей за единицу валюты: ручной курс перекрывает курс ЦБ. null — курса нет. */
export function effectiveRate(currency: Currency, rates: Rate[]): number | null {
  if (currency === 'RUB') return 1
  const r = rates.find(x => x.currency === currency)
  if (!r) return null
  return r.manual_rate ?? r.cbr_rate
}

export function toRub(amount: number, currency: Currency, rates: Rate[]): number | null {
  const k = effectiveRate(currency, rates)
  return k === null ? null : amount * k
}

/** Перевод между любыми валютами через рубль. */
export function convert(amount: number, from: Currency, to: Currency, rates: Rate[]): number | null {
  const rub = toRub(amount, from, rates)
  const k = effectiveRate(to, rates)
  return rub === null || k === null ? null : rub / k
}

const sign = (c: Currency) => CURRENCIES.find(x => x.id === c)!.sign

export function fmtMoney(amount: number | null | undefined, currency: Currency = 'RUB', digits?: number) {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—'
  const d = digits ?? (Math.abs(amount) >= 1000 || Number.isInteger(amount) ? 0 : 2)
  const s = amount.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d })
  return `${s} ${sign(currency)}`
}

export function fmtQty(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 3 })
}

/** Разбор суммы, как её вводят руками: «3 200,50», «3200.5». NaN — если не число. */
export function parseAmount(s: string): number {
  const t = s.replace(/[\s ]/g, '').replace(',', '.')
  return t === '' ? NaN : Number(t)
}

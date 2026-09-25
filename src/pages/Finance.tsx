import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus, Tags } from 'lucide-react'
import { sellingPrice, type Expense } from '../catalog'
import { DictEditor, useCosting, useDicts, useProducts, useRates, useSuppliers } from '../catalogParts'
import { unitEconomics } from '../costing'
import { byMonth, inRange, periodRange, sumBy, type Period } from '../finance'
import { BarList, ExpenseModal, ExpenseTable, MonthBars, useExpenses } from '../financeParts'
import { fmtMoney, toRub } from '../money'
import { DateInput, PageHeader, QueryState } from '../ui'

const PERIODS: { id: Period; label: string }[] = [
  { id: 'month', label: 'Этот месяц' }, { id: 'quarter', label: 'Этот квартал' }, { id: 'year', label: 'Этот год' },
  { id: 'all', label: 'Всё время' }, { id: 'custom', label: 'Свой период' },
]

export default function Finance() {
  const [sp, setSp] = useSearchParams()
  const [open, setOpen] = useState<Expense | 'new' | null>(null)
  const [cats, setCats] = useState(false)
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set(k, v); else n.delete(k)
    setSp(n, { replace: true })
  }
  const period = (sp.get('period') as Period) || 'year'
  const from = sp.get('from') ?? '', to = sp.get('to') ?? ''
  const product = sp.get('product') ?? '', category = sp.get('category') ?? '', supplier = sp.get('supplier') ?? ''

  const expenses = useExpenses()
  const dicts = useDicts('expense_category')
  const products = useProducts()
  const sups = useSuppliers()
  const costing = useCosting()
  const rates = useRates()

  const range = periodRange(period, new Date(), { from, to })
  const all = expenses.data ?? []
  const list = useMemo(() => all.filter(e => inRange(e.spent_on, range)
    && (!product || (product === 'none' ? !e.product_id : e.product_id === product))
    && (!category || (category === 'none' ? !e.category_id : e.category_id === category))
    && (!supplier || e.supplier_id === supplier)), [all, range?.from, range?.to, product, category, supplier]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = list.reduce((s, e) => s + e.amount_rub, 0)
  // будущие месяцы периода не в счёт: иначе «в среднем за месяц» делится на ещё не наступившие
  const todayKey = new Date().toISOString().slice(0, 10)
  const months = byMonth(list, range && { from: range.from, to: range.to < todayKey ? range.to : todayKey })
  const catName = (id: string | null) => dicts.data?.find(d => d.id === id)
  const prodName = (id: string | null) => products.data?.find(p => p.id === id)
  const byCat = sumBy(list, e => e.category_id).map(r => ({
    key: r.id ?? 'none', sum: r.sum, label: catName(r.id)?.name ?? 'Без категории', dot: catName(r.id)?.color,
  }))
  const byProd = sumBy(list, e => e.product_id).map(r => ({
    key: r.id ?? 'none', sum: r.sum, label: prodName(r.id)?.name ?? 'Не привязано к изделию', href: r.id ? `/products/${r.id}` : undefined,
  }))
  const bySup = sumBy(list.filter(e => e.supplier_id), e => e.supplier_id).slice(0, 6).map(r => ({
    key: r.id!, sum: r.sum, label: sups.data?.find(s => s.id === r.id)?.name ?? '—', href: `/suppliers/${r.id}`,
  }))

  // экономика изделий: для плановой выручки и таблицы маржи
  const econ = (products.data ?? []).map(p => {
    const price = sellingPrice(p)
    const priceRub = price === null ? null : toRub(price, p.price_currency, rates.data ?? [])
    const material = costing.k?.product(p.id).total ?? 0
    return { p, u: unitEconomics(material, p, priceRub) }
  })
  const planRevenue = econ.reduce((s, x) => s + (x.u.price ?? 0) * x.p.planned_qty, 0)
  const planProfit = econ.reduce((s, x) => s + (x.u.profit ?? 0) * x.p.planned_qty, 0)
  const filtered = product || category || supplier

  return (
    <>
      <PageHeader title="Финансы" sub="Расходы, себестоимость и маржа. Все суммы в рублях: валютные расходы — по курсу на момент записи."
        actions={<>
          <button className="dash-btn dash-btn-ghost" onClick={() => setCats(true)}><Tags className="h-4 w-4" aria-hidden /> Категории</button>
          <button className="dash-btn" onClick={() => setOpen('new')}><Plus className="h-4 w-4" aria-hidden /> Новый расход</button>
        </>} />

      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-[1fr_1fr_1fr_1fr_auto]">
        <select className="dash-input" value={period} onChange={e => setParam('period', e.target.value === 'year' ? '' : e.target.value)} aria-label="Период">
          {PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <select className="dash-input" value={product} onChange={e => setParam('product', e.target.value)} aria-label="Изделие">
          <option value="">Все изделия</option>
          {products.data?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option value="none">Без изделия</option>
        </select>
        <select className="dash-input" value={category} onChange={e => setParam('category', e.target.value)} aria-label="Категория">
          <option value="">Все категории</option>
          {dicts.data?.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          <option value="none">Без категории</option>
        </select>
        <select className="dash-input" value={supplier} onChange={e => setParam('supplier', e.target.value)} aria-label="Поставщик">
          <option value="">Все поставщики</option>
          {sups.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {filtered && <button className="dash-btn dash-btn-ghost col-span-2 md:col-span-1" onClick={() => setSp(period === 'year' ? {} : { period }, { replace: true })}>Сбросить</button>}
        {period === 'custom' && (
          <div className="col-span-2 flex items-center gap-2 md:col-span-4 xl:col-span-5">
            <span className="dash-muted text-sm">с</span><div className="w-44"><DateInput value={from} onChange={v => setParam('from', v)} label="С" /></div>
            <span className="dash-muted text-sm">по</span><div className="w-44"><DateInput value={to} onChange={v => setParam('to', v)} label="По" /></div>
          </div>
        )}
      </div>

      <QueryState loading={expenses.isLoading} error={expenses.error} onRetry={() => expenses.refetch()}>
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label={`Расходы · ${PERIODS.find(p => p.id === period)!.label.toLowerCase()}`} value={fmtMoney(total, 'RUB')} sub={`${list.length} записей`} />
          <Tile label="В среднем за месяц" value={fmtMoney(months.length ? total / months.length : 0, 'RUB')} sub={`${months.length} мес.`} />
          <Tile label="Плановая выручка" value={fmtMoney(planRevenue, 'RUB')} sub="цена × план продаж" />
          <Tile label="Плановая прибыль" value={fmtMoney(planProfit, 'RUB')} sub={planRevenue ? `маржа ${((planProfit / planRevenue) * 100).toFixed(1)}%` : 'задайте план в изделиях'} tone={planProfit < 0 ? 'bad' : undefined} />
        </div>

        <section className="dash-card mb-4 p-4" aria-label="Расходы по месяцам">
          <h2 className="dash-label mb-4">Расходы по месяцам</h2>
          <MonthBars data={months} />
        </section>

        <div className="mb-4 grid gap-4 lg:grid-cols-3">
          <section className="dash-card min-w-0 p-4" aria-label="По категориям"><h2 className="dash-label mb-3">По категориям</h2><BarList rows={byCat} total={total} /></section>
          <section className="dash-card min-w-0 p-4" aria-label="По изделиям"><h2 className="dash-label mb-3">По изделиям</h2><BarList rows={byProd} total={total} /></section>
          <section className="dash-card min-w-0 p-4" aria-label="По поставщикам"><h2 className="dash-label mb-3">По поставщикам</h2><BarList rows={bySup} total={total} empty="Нет расходов с поставщиком" /></section>
        </div>

        <section className="dash-card mb-4 min-w-0 p-4" aria-label="Экономика изделий">
          <h2 className="dash-label mb-2">Экономика изделий · за 1 шт</h2>
          {econ.length === 0 ? <p className="dash-muted text-sm">Изделий пока нет</p> : (
            <>
            <ul className="md:hidden">
              {econ.map(({ p, u }) => (
                <li key={p.id} className="dash-row py-2.5 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <Link className="font-medium hover:underline" to={`/products/${p.id}`}>{p.name}{p.version ? ` ${p.version}` : ''}</Link>
                    <b className={`shrink-0 tabular-nums ${u.margin === null ? '' : u.margin >= 0 ? 'text-[var(--d-ok)]' : 'text-[var(--d-danger)]'}`}>{u.margin === null ? '—' : `${u.margin.toFixed(1)}%`}</b>
                  </div>
                  <div className="dash-muted text-xs tabular-nums">
                    цена {fmtMoney(u.price, 'RUB')} · себест. {fmtMoney(u.total, 'RUB')} · прибыль {fmtMoney(u.profit, 'RUB')}{p.planned_qty ? ` · план ${p.planned_qty} шт` : ''}
                  </div>
                </li>
              ))}
            </ul>
            <div className="-mx-4 hidden overflow-x-auto md:block">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="dash-label border-b border-[var(--d-line)] text-left">
                    <th className="py-2 pl-4 pr-2 font-medium">Изделие</th>
                    <th className="px-2 py-2 text-right font-medium">Цена</th>
                    <th className="px-2 py-2 text-right font-medium">Себестоимость</th>
                    <th className="px-2 py-2 text-right font-medium">Прибыль</th>
                    <th className="px-2 py-2 text-right font-medium">Маржа</th>
                    <th className="py-2 pl-2 pr-4 text-right font-medium">План, шт</th>
                  </tr>
                </thead>
                <tbody>
                  {econ.map(({ p, u }) => (
                    <tr key={p.id} className="dash-row">
                      <td className="py-2.5 pl-4 pr-2"><Link className="font-medium hover:underline" to={`/products/${p.id}`}>{p.name}{p.version ? ` ${p.version}` : ''}</Link></td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{fmtMoney(u.price, 'RUB')}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{fmtMoney(u.total, 'RUB')}{u.override !== null && <span className="ml-1 text-[10px] uppercase text-[var(--d-warn)]">ручн.</span>}</td>
                      <td className={`px-2 py-2.5 text-right font-medium tabular-nums ${u.profit === null ? '' : u.profit >= 0 ? 'text-[var(--d-ok)]' : 'text-[var(--d-danger)]'}`}>{fmtMoney(u.profit, 'RUB')}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{u.margin === null ? '—' : `${u.margin.toFixed(1)}%`}</td>
                      <td className="dash-muted py-2.5 pl-2 pr-4 text-right tabular-nums">{p.planned_qty || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </section>

        <section className="dash-card min-w-0 p-4" aria-label="Расходы">
          <h2 className="dash-label mb-2">Расходы · {list.length}</h2>
          {list.length === 0
            ? <p className="dash-muted py-6 text-center text-sm">{all.length ? 'Под фильтры ничего не подходит' : 'Расходов пока нет — добавьте первый кнопкой «Новый расход»'}</p>
            : <ExpenseTable items={list} onOpen={e => setOpen(e)} />}
        </section>
      </QueryState>

      <ExpenseModal open={open !== null} expense={open === 'new' ? null : open} onClose={() => setOpen(null)}
        preset={product && product !== 'none' ? { product_id: product } : undefined} />
      <DictEditor kind="expense_category" title="Категории расходов" open={cats} onClose={() => setCats(false)}
        usage={id => all.filter(e => e.category_id === id).length} />
    </>
  )
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <div className="dash-card p-4">
      <div className="dash-label !text-[10px]">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums md:text-2xl ${tone === 'bad' ? 'text-[var(--d-danger)]' : ''}`}>{value}</div>
      {sub && <div className="dash-muted mt-0.5 text-xs">{sub}</div>}
    </div>
  )
}

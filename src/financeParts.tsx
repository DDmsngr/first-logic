import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageCircle, Trash2 } from 'lucide-react'
import {
  createExpense, deleteExpense, fetchComponents, fetchExpenses, updateExpense,
  type Expense, type ExpenseInput,
} from './catalog'
import { fetchAttachments } from './api'
import { useWorkspace } from './auth'
import { DictChip, ProductSelect, useDicts, useRates, useSuppliers } from './catalogParts'
import type { UnitEconomics } from './costing'
import { monthLabel } from './finance'
import { fmtDate } from './meta'
import { CURRENCIES, effectiveRate, fmtMoney, parseAmount, type Currency } from './money'
import { FileList, UploadButton } from './shared'
import { DateInput, Field, Modal, errMsg, useToast } from './ui'

export function useExpenses(opts: { supplierId?: string; productId?: string } = {}) {
  const { workspace } = useWorkspace()
  return useQuery({ queryKey: ['expenses', workspace.id, opts], queryFn: () => fetchExpenses(workspace.id, opts) })
}

const REFRESH = ['expenses', 'activity']

// ── форма расхода ───────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10)

export function ExpenseForm({ initial, busy, submitLabel, onSubmit, onCancel, onDelete }: {
  initial: Partial<ExpenseInput>; busy?: boolean; submitLabel: string
  onSubmit: (e: ExpenseInput) => void; onCancel: () => void; onDelete?: () => void
}) {
  const { workspace } = useWorkspace()
  const cats = useDicts('expense_category')
  const sups = useSuppliers()
  const rates = useRates()
  const comps = useQuery({ queryKey: ['components', workspace.id, { archived: false }], queryFn: () => fetchComponents(workspace.id) })
  const toast = useToast()
  const [f, setF] = useState({
    spent_on: initial.spent_on ?? today(), category_id: initial.category_id ?? '', description: initial.description ?? '',
    amount: initial.amount ? String(initial.amount) : '', currency: (initial.currency ?? 'RUB') as Currency,
    rate: initial.rate_rub ? String(initial.rate_rub) : '', supplier_id: initial.supplier_id ?? '',
    product_id: initial.product_id ?? null as string | null, component_id: initial.component_id ?? '', note: initial.note ?? '',
  })
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))
  const current = effectiveRate(f.currency, rates.data ?? [])
  // курс не задан вручную — берём текущий
  const rate = f.currency === 'RUB' ? 1 : (f.rate.trim() ? parseAmount(f.rate) : current)
  const amount = parseAmount(f.amount)
  const rub = Number.isFinite(amount) && rate ? amount * rate : null

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!Number.isFinite(amount) || amount <= 0) { toast('Сумма должна быть больше нуля', 'error'); return }
    if (!rate || !Number.isFinite(rate) || rate <= 0) { toast(`Нет курса ${f.currency} — укажите его вручную`, 'error'); return }
    onSubmit({
      spent_on: f.spent_on || today(), category_id: f.category_id || null, description: f.description.trim(), amount,
      currency: f.currency, rate_rub: rate, supplier_id: f.supplier_id || null, product_id: f.product_id,
      component_id: f.component_id || null, note: f.note,
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Описание"><input className="dash-input" required autoFocus maxLength={300} value={f.description} onChange={e => set('description')(e.target.value)} placeholder="Изготовление корпусов для 200W" /></Field></div>
      <Field label="Сумма" hint={rub !== null && f.currency !== 'RUB' ? `= ${fmtMoney(rub, 'RUB')}` : undefined}>
        <div className="flex gap-2">
          <input className="dash-input" inputMode="decimal" required value={f.amount} onChange={e => set('amount')(e.target.value)} aria-label="Сумма" />
          <select className="dash-input !w-24 shrink-0" value={f.currency} aria-label="Валюта"
            onChange={e => setF(x => ({ ...x, currency: e.target.value as Currency, rate: '' }))}>
            {CURRENCIES.map(c => <option key={c.id} value={c.id}>{c.id}</option>)}
          </select>
        </div>
      </Field>
      {f.currency === 'RUB' ? (
        <Field label="Дата"><DateInput value={f.spent_on} onChange={set('spent_on')} /></Field>
      ) : (
        <Field label="Курс, ₽" hint={current ? `Сейчас ${current.toLocaleString('ru-RU', { maximumFractionDigits: 4 })} — сохранится вместе с расходом` : 'Курса нет — введите'}>
          <input className="dash-input" inputMode="decimal" placeholder={current ? String(current).replace('.', ',') : ''} value={f.rate} onChange={e => set('rate')(e.target.value)} />
        </Field>
      )}
      {f.currency !== 'RUB' && <Field label="Дата"><DateInput value={f.spent_on} onChange={set('spent_on')} /></Field>}
      <Field label="Категория">
        <select className="dash-input" value={f.category_id} onChange={e => set('category_id')(e.target.value)}>
          <option value="">Без категории</option>
          {cats.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Поставщик">
        <select className="dash-input" value={f.supplier_id} onChange={e => set('supplier_id')(e.target.value)}>
          <option value="">Не указан</option>
          {sups.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Изделие"><ProductSelect value={f.product_id} onChange={set('product_id')} /></Field>
      <Field label="Компонент">
        <select className="dash-input" value={f.component_id} onChange={e => set('component_id')(e.target.value)}>
          <option value="">Не указан</option>
          {comps.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <div className="sm:col-span-2"><Field label="Комментарий"><textarea className="dash-input" value={f.note} onChange={e => set('note')(e.target.value)} /></Field></div>
      <div className="flex flex-wrap justify-between gap-2 sm:col-span-2">
        {onDelete ? <button type="button" className="dash-btn dash-btn-ghost !text-[var(--d-danger)]" onClick={onDelete}><Trash2 className="h-4 w-4" aria-hidden /> Удалить</button> : <span />}
        <div className="flex gap-2">
          <button type="button" className="dash-btn dash-btn-ghost" onClick={onCancel}>Отмена</button>
          <button className="dash-btn" disabled={busy || !f.description.trim()}>{busy ? 'Сохраняем…' : submitLabel}</button>
        </div>
      </div>
    </form>
  )
}

/** Создание (expense = null + open) или правка расхода; у существующего — чеки. */
export function ExpenseModal({ open, expense, preset, onClose }: {
  open: boolean; expense: Expense | null; preset?: Partial<ExpenseInput>; onClose: () => void
}) {
  const { workspace } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [created, setCreated] = useState<Expense | null>(null)
  const current = expense ?? created
  const files = useQuery({
    queryKey: ['attachments', 'expense', current?.id], queryFn: () => fetchAttachments({ expenseId: current!.id }), enabled: !!current,
  })
  const close = () => { setCreated(null); onClose() }
  const refresh = () => REFRESH.forEach(k => qc.invalidateQueries({ queryKey: [k] }))

  const save = useMutation({
    mutationFn: (e: ExpenseInput) => (expense ? updateExpense(expense.id, e).then(() => null) : createExpense(workspace.id, e)),
    onSuccess: e => {
      refresh()
      if (e) { setCreated(e); toast('Расход добавлен — можно прикрепить чек') } else { toast('Сохранено'); close() }
    },
    onError: e => toast(errMsg(e), 'error'),
  })
  const del = useMutation({
    mutationFn: () => deleteExpense(expense!.id),
    onSuccess: () => { refresh(); toast('Расход удалён'); close() },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <Modal open={open} onClose={close} guard={!created} title={created ? 'Расход добавлен' : expense ? 'Расход' : 'Новый расход'}>
      {open && !created && (
        <ExpenseForm key={expense?.id ?? 'new'} initial={expense ?? preset ?? {}} busy={save.isPending} submitLabel={expense ? 'Сохранить' : 'Добавить'}
          onSubmit={e => save.mutate(e)} onCancel={close}
          onDelete={expense ? () => confirm(`Удалить расход «${expense.description}»?`) && del.mutate() : undefined} />
      )}
      {current && (
        <div className={created ? '' : 'mt-5 border-t border-[var(--d-line)] pt-4'}>
          {created && <p className="mb-3 text-sm">«{created.description}» — {fmtMoney(created.amount_rub, 'RUB')}</p>}
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="dash-label">Чеки и документы · {files.data?.length ?? 0}</h3>
            <UploadButton target={{ expenseId: current.id }} label="Прикрепить" />
          </div>
          {files.data && files.data.length > 0 && <FileList files={files.data} />}
          {created && <div className="mt-4 flex justify-end"><button className="dash-btn" onClick={close}>Готово</button></div>}
        </div>
      )}
    </Modal>
  )
}

// ── список расходов ─────────────────────────────────────────────────────────

export function ExpenseTable({ items, onOpen, compact }: { items: Expense[]; onOpen: (e: Expense) => void; compact?: boolean }) {
  const cats = useDicts('expense_category')
  const sups = useSuppliers()
  const cat = (id: string | null) => cats.data?.find(c => c.id === id)
  const sup = (id: string | null) => sups.data?.find(s => s.id === id)
  return (
    <>
      <ul className="md:hidden">
        {items.map(e => (
          <li key={e.id}>
            <button type="button" onClick={() => onOpen(e)} className="dash-row flex w-full items-start gap-3 py-2.5 text-left text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{e.description}</div>
                <div className="dash-muted text-xs">{fmtDate(e.spent_on)}{cat(e.category_id) && ` · ${cat(e.category_id)!.name}`}{sup(e.supplier_id) && ` · ${sup(e.supplier_id)!.name}`}</div>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <b>{fmtMoney(e.amount_rub, 'RUB')}</b>
                {e.currency !== 'RUB' && <div className="dash-muted text-xs">{fmtMoney(e.amount, e.currency)}</div>}
              </div>
            </button>
          </li>
        ))}
      </ul>
      <div className="-mx-4 hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="dash-label border-b border-[var(--d-line)] text-left">
              <th className="py-2 pl-4 pr-2 font-medium">Дата</th>
              <th className="px-2 py-2 font-medium">Описание</th>
              <th className="px-2 py-2 font-medium">Категория</th>
              {!compact && <th className="px-2 py-2 font-medium">Поставщик</th>}
              <th className="py-2 pl-2 pr-4 text-right font-medium">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {items.map(e => (
              <tr key={e.id} className="dash-row cursor-pointer align-top hover:bg-[var(--d-raised)]" onClick={() => onOpen(e)}>
                <td className="dash-muted whitespace-nowrap py-2.5 pl-4 pr-2 tabular-nums">{fmtDate(e.spent_on)}</td>
                <td className="px-2 py-2.5">
                  <span className="font-medium">{e.description}</span>
                  {e.source === 'telegram' && <MessageCircle className="ml-1.5 inline h-3.5 w-3.5 text-[var(--d-accent)]" aria-label="Из Telegram" />}
                  {e.note && <div className="dash-muted line-clamp-1 text-xs">{e.note}</div>}
                </td>
                <td className="px-2 py-2.5"><DictChip dict={cat(e.category_id)} /></td>
                {!compact && <td className="px-2 py-2.5">{sup(e.supplier_id)?.name ?? <span className="dash-muted">—</span>}</td>}
                <td className="whitespace-nowrap py-2.5 pl-2 pr-4 text-right tabular-nums">
                  <b>{fmtMoney(e.amount_rub, 'RUB')}</b>
                  {e.currency !== 'RUB' && <div className="dash-muted text-xs">{fmtMoney(e.amount, e.currency)} × {e.rate_rub.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ── графики ─────────────────────────────────────────────────────────────────
// Одна серия → один оттенок (акцент), без легенды: заголовок её называет.
// Тонкие столбики, скругление 4px только у конца данных, зазор 2px, подсказка при наведении.

export function MonthBars({ data }: { data: { month: string; sum: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...data.map(d => d.sum), 1)
  const step = niceStep(max)
  const top = Math.ceil(max / step) * step
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  if (!data.length) return <p className="dash-muted py-8 text-center text-sm">Расходов за период нет</p>
  return (
    <div className="relative" role="img" aria-label={`Расходы по месяцам: ${data.map(d => `${monthLabel(d.month)} ${fmtMoney(d.sum, 'RUB')}`).join(', ')}`}>
      <div className="relative ml-14 h-48">
        {ticks.map(t => (
          <div key={t} className="absolute inset-x-0 border-t border-[var(--d-line)]/60" style={{ bottom: `${(t / top) * 100}%` }}>
            <span className="dash-muted absolute -left-14 -top-2 w-12 text-right text-[10px] tabular-nums">{compact(t)}</span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {data.map((d, i) => (
            <div key={d.month} className="relative flex h-full flex-1 items-end justify-center"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0}
              aria-label={`${monthLabel(d.month)}: ${fmtMoney(d.sum, 'RUB')}`}>
              <div className="w-full max-w-10 rounded-t-[4px] transition-opacity"
                style={{ height: `${(d.sum / top) * 100}%`, minHeight: d.sum ? 2 : 0, background: 'var(--d-accent)', opacity: hover === null || hover === i ? 1 : 0.45 }} />
              {hover === i && (
                <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md border border-[var(--d-line-strong)] bg-[var(--d-raised)] px-2 py-1 text-xs shadow-lg">
                  <div className="dash-muted">{monthLabel(d.month)}</div>
                  <b className="tabular-nums">{fmtMoney(d.sum, 'RUB')}</b>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="ml-14 mt-1 flex gap-[2px]">
        {data.map((d, i) => (
          <span key={d.month} className="dash-muted flex-1 truncate text-center text-[10px]">
            {data.length <= 12 || i % Math.ceil(data.length / 12) === 0 ? monthLabel(d.month) : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

function niceStep(max: number) {
  const raw = max / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  const n = raw / pow
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow
}

const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн` : n >= 1e3 ? `${(n / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс` : String(n)

/** Горизонтальные столбики «название — сумма — доля»: значения подписаны, цвет один. */
export function BarList({ rows, total, empty = 'Нет данных' }: {
  rows: { key: string; label: React.ReactNode; sum: number; href?: string; dot?: string }[]; total: number; empty?: string
}) {
  if (!rows.length) return <p className="dash-muted py-4 text-sm">{empty}</p>
  const max = Math.max(...rows.map(r => r.sum), 1)
  return (
    <ul className="space-y-2.5">
      {rows.map(r => (
        <li key={r.key} className="text-sm" title={`${fmtMoney(r.sum, 'RUB')} · ${total ? ((r.sum / total) * 100).toFixed(0) : 0}%`}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {r.dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.dot }} aria-hidden />}
              {r.href ? <Link className="truncate hover:underline" to={r.href}>{r.label}</Link> : <span className="truncate">{r.label}</span>}
            </span>
            <span className="shrink-0 tabular-nums"><b>{fmtMoney(r.sum, 'RUB')}</b> <span className="dash-muted text-xs">{total ? ((r.sum / total) * 100).toFixed(0) : 0}%</span></span>
          </div>
          <div className="h-1.5 rounded-full bg-[var(--d-line)]/50">
            <div className="h-full rounded-full bg-[var(--d-accent)]" style={{ width: `${(r.sum / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

// ── структура цены ──────────────────────────────────────────────────────────
// Четыре слота эталонной категориальной палитры (тёмные шаги), проверены
// validate_palette.js на поверхности #10151b: все проверки пройдены.
export const STRUCTURE_COLORS = { material: '#3987e5', manufacturing: '#d95926', additional: '#199e70', profit: '#c98500' }

export function PriceStructure({ u }: { u: UnitEconomics }) {
  if (!u.price || u.price <= 0) return null
  const parts = [
    { key: 'material', label: 'Материалы', v: u.override === null ? u.material : null },
    { key: 'manufacturing', label: 'Производство', v: u.override === null ? u.manufacturing : null },
    { key: 'additional', label: 'Прочее и накладные', v: u.override === null ? u.additional + u.overhead : null },
    { key: 'cost', label: 'Себестоимость (ручная)', v: u.override },
    { key: 'profit', label: u.profit! >= 0 ? 'Прибыль' : 'Убыток', v: Math.max(u.profit ?? 0, 0) },
  ].filter(p => p.v !== null && p.v > 0) as { key: string; label: string; v: number }[]
  const color = (k: string) => (k === 'cost' ? STRUCTURE_COLORS.material : STRUCTURE_COLORS[k as keyof typeof STRUCTURE_COLORS])
  const base = Math.max(u.price, u.total)
  return (
    <div>
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-[4px]" role="img"
        aria-label={`Структура цены: ${parts.map(p => `${p.label} ${fmtMoney(p.v, 'RUB')}`).join(', ')}`}>
        {parts.map(p => <div key={p.key} style={{ width: `${(p.v / base) * 100}%`, background: color(p.key) }} title={`${p.label}: ${fmtMoney(p.v, 'RUB')}`} />)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {parts.map(p => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: color(p.key) }} aria-hidden />
            <span className="dash-muted">{p.label}</span>
            <span className="tabular-nums">{((p.v / u.price!) * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}


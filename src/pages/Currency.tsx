import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, RefreshCw, X } from 'lucide-react'
import { refreshRates, setManualRate } from '../catalog'
import { useRates } from '../catalogParts'
import { CURRENCIES, convert, effectiveRate, fmtMoney, parseAmount, type Currency, type Rate } from '../money'
import { fmtDate, fmtDateTime, timeAgo } from '../meta'
import { Field, PageHeader, QueryState, errMsg, useToast } from '../ui'

const fmtRate = (n: number | null) => (n === null ? '—' : n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 4 }))

export default function CurrencyPage() {
  const rates = useRates()
  const qc = useQueryClient()
  const toast = useToast()
  const list = rates.data ?? []
  const lastFetch = list.map(r => r.fetched_at).filter(Boolean).sort().at(-1) ?? null

  const refresh = useMutation({
    mutationFn: refreshRates,
    onSuccess: src => { toast(src === 'cbr' ? 'Курсы ЦБ обновлены' : 'Курсы обновлены сервером'); qc.invalidateQueries({ queryKey: ['rates'] }) },
    onError: e => toast(`Не удалось обновить: ${errMsg(e)}`, 'error'),
  })

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Курсы валют"
        sub={<>Курс ЦБ РФ подтягивается сам: при открытии dashboard, если курсу больше 12 часов, и раз в сутки сервером. {lastFetch && <>Последнее обновление: <span title={fmtDateTime(lastFetch)}>{timeAgo(lastFetch)}</span>.</>}</>}
        actions={<button className="dash-btn dash-btn-ghost" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          <RefreshCw className={`h-4 w-4 ${refresh.isPending ? 'animate-spin' : ''}`} aria-hidden /> Обновить сейчас
        </button>} />

      <Converter rates={list} />

      <QueryState loading={rates.isLoading} error={rates.error} onRetry={() => rates.refetch()}>
        <section className="dash-card mt-4 overflow-x-auto" aria-label="Курсы">
          <table className="w-full text-sm">
            <thead>
              <tr className="dash-label border-b border-[var(--d-line)] text-left">
                <th className="px-4 py-3 font-medium">Валюта</th>
                <th className="px-3 py-3 text-right font-medium">Курс ЦБ</th>
                <th className="px-3 py-3 font-medium">Свой курс</th>
                <th className="px-4 py-3 text-right font-medium">Действует</th>
              </tr>
            </thead>
            <tbody>{list.map(r => <RateRow key={r.currency} r={r} />)}</tbody>
          </table>
          <p className="dash-muted border-t border-[var(--d-line)] px-4 py-3 text-xs">
            Свой курс — например, курс банка или поставщика. Пока он задан, все суммы в этой валюте считаются по нему; очистите поле, чтобы вернуться к курсу ЦБ.
          </p>
        </section>
      </QueryState>
    </div>
  )
}

function RateRow({ r }: { r: Rate }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState(r.manual_rate === null ? '' : String(r.manual_rate).replace('.', ','))
  const save = useMutation({
    mutationFn: (rate: number | null) => setManualRate(r.currency, rate),
    onSuccess: (_d, rate) => { toast(rate === null ? `${r.currency}: снова курс ЦБ` : `${r.currency}: свой курс сохранён`); qc.invalidateQueries({ queryKey: ['rates'] }) },
    onError: e => toast(errMsg(e), 'error'),
  })
  const commit = () => {
    if (!v.trim()) { if (r.manual_rate !== null) save.mutate(null); return }
    const n = parseAmount(v)
    if (!Number.isFinite(n) || n <= 0) { toast('Курс должен быть положительным числом', 'error'); return }
    if (n !== r.manual_rate) save.mutate(n)
  }
  const eff = r.manual_rate ?? r.cbr_rate
  const diff = r.manual_rate !== null && r.cbr_rate ? (r.manual_rate / r.cbr_rate - 1) * 100 : null
  const meta = CURRENCIES.find(c => c.id === r.currency)!

  return (
    <tr className="dash-row align-middle">
      <td className="px-4 py-3">
        <div className="font-medium"><span className="dash-mono">{r.currency}</span> <span className="dash-muted">{meta.sign}</span></div>
        <div className="dash-muted text-xs">{meta.label}</div>
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {fmtRate(r.cbr_rate)} ₽
        <div className="dash-muted text-xs">{r.cbr_date ? `на ${fmtDate(r.cbr_date)}` : 'ещё не загружен'}</div>
        {r.source === 'market' && r.cbr_rate !== null && <div className="text-[10px] text-[var(--d-warn)]" title="ЦБ был недоступен — взят рыночный курс exchangerate-api.com">рыночный, не ЦБ</div>}
      </td>
      <td className="px-3 py-3">
        <div className="flex max-w-44 items-center gap-1">
          <input className="dash-input !min-h-9" inputMode="decimal" placeholder="не задан" value={v} aria-label={`Свой курс ${r.currency}`}
            onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
          {r.manual_rate !== null && (
            <button className="dash-btn dash-btn-ghost dash-btn-sm !min-h-9 shrink-0" aria-label="Сбросить свой курс" onClick={() => { setV(''); save.mutate(null) }}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        <span className="font-semibold">{fmtRate(eff)} ₽</span>
        <div className="text-xs">
          {r.manual_rate !== null
            ? <span className="text-[var(--d-warn)]">свой{diff !== null && `, ${diff > 0 ? '+' : ''}${diff.toFixed(1)}% к ЦБ`}</span>
            : <span className="dash-muted">ЦБ</span>}
        </div>
      </td>
    </tr>
  )
}

function Converter({ rates }: { rates: Rate[] }) {
  const [amount, setAmount] = useState('100')
  const [from, setFrom] = useState<Currency>('USD')
  const [to, setTo] = useState<Currency>('RUB')
  const n = parseAmount(amount)
  const result = Number.isFinite(n) ? convert(n, from, to, rates) : null
  const k = convert(1, from, to, rates)
  const fromRate = effectiveRate(from, rates)

  return (
    <section className="dash-card p-4" aria-label="Конвертер">
      <h2 className="dash-label mb-3">Конвертер</h2>
      <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <Field label="Сумма">
          <div className="flex gap-2">
            <input className="dash-input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} aria-label="Сумма" />
            <CurSelect value={from} onChange={setFrom} label="Из валюты" />
          </div>
        </Field>
        <button className="dash-btn dash-btn-ghost mb-0.5 !px-3" aria-label="Поменять местами" onClick={() => { setFrom(to); setTo(from) }}>
          <ArrowLeftRight className="h-4 w-4" aria-hidden />
        </button>
        <Field label="Получится">
          <div className="flex gap-2">
            <output className="dash-input flex items-center font-semibold tabular-nums" aria-live="polite">
              {result === null ? '—' : result.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}
            </output>
            <CurSelect value={to} onChange={setTo} label="В валюту" />
          </div>
        </Field>
      </div>
      <p className="dash-muted mt-2 text-xs">
        {k === null ? 'Для этой пары нет курса' : `1 ${from} = ${k.toLocaleString('ru-RU', { maximumFractionDigits: 4 })} ${to}`}
        {from !== 'RUB' && to !== 'RUB' && Number.isFinite(n) && fromRate !== null && <> · в рублях: {fmtMoney(n * fromRate, 'RUB')}</>}
      </p>
    </section>
  )
}

function CurSelect({ value, onChange, label }: { value: Currency; onChange: (c: Currency) => void; label: string }) {
  return (
    <select className="dash-input !w-24 shrink-0" value={value} onChange={e => onChange(e.target.value as Currency)} aria-label={label}>
      {CURRENCIES.map(c => <option key={c.id} value={c.id}>{c.id}</option>)}
    </select>
  )
}

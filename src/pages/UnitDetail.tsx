import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useWorkspace } from '../auth'
import { fmtDate, fmtDateTime } from '../meta'
import { fmtQty } from '../money'
import { fetchUnitTrace, updateUnit } from '../stock'
import { ResultChip } from '../qualityUi'
import { outOfRange } from '../quality'
import { Field, PageHeader, QueryState, errMsg, useToast } from '../ui'
import { UnitActions, UnitChip, unitsRefresh } from '../units'

/** «Паспорт» экземпляра: из какой партии деталей, как испытан, кому ушёл. */
export default function UnitDetail() {
  const { id = '' } = useParams()
  const { byUser } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['unit', id], queryFn: () => fetchUnitTrace(id) })
  const u = q.data
  const [note, setNote] = useState<string | null>(null)
  const saveNote = useMutation({
    mutationFn: () => updateUnit(id, { note: (note ?? '').trim() }),
    onSuccess: () => { toast('Сохранено'); setNote(null); unitsRefresh(qc) },
    onError: e => toast(errMsg(e), 'error'),
  })

  if (!u) return <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty emptyText="Экземпляр не найден"><></></QueryState>
  const b = u.build
  const perUnit = b ? b.lines.map(l => ({ ...l, per: l.qty / (b.qty || 1) })) : []

  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/units" className="dash-muted mb-3 inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> Экземпляры</Link>
      <PageHeader title={u.serial}
        sub={<span className="flex flex-wrap items-center gap-2">
          <UnitChip status={u.status} />
          {u.product && <Link to={`/products/${u.product.id}`} className="hover:underline">{u.product.name}{u.product.version ? ` ${u.product.version}` : ''}</Link>}
        </span>}
        actions={<UnitActions u={u} />} />

      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <section className="dash-card p-4" aria-label="Сборка">
          <h2 className="dash-label mb-2">Сборка</h2>
          {b ? (
            <dl className="space-y-1 text-sm">
              <div><dt className="dash-muted inline">Собран: </dt><dd className="inline">{fmtDateTime(b.created_at)}, {byUser(b.created_by)?.name ?? '—'}</dd></div>
              <div><dt className="dash-muted inline">Партия: </dt><dd className="inline">{fmtQty(b.qty)} шт{b.note ? ` · ${b.note}` : ''}</dd></div>
            </dl>
          ) : <p className="dash-muted text-sm">Собран до внедрения системы или заведён вручную: данных о сборке нет.</p>}
        </section>
        <section className="dash-card p-4" aria-label="Отгрузка">
          <h2 className="dash-label mb-2">Отгрузка</h2>
          {u.status === 'shipped'
            ? <p className="text-sm"><b>{u.customer || '—'}</b><span className="dash-muted"> · {fmtDate(u.shipped_on)}</span></p>
            : <p className="dash-muted text-sm">{u.status === 'scrap' ? 'Списан в брак' : 'Пока на складе'}</p>}
        </section>
      </div>

      <section className="dash-card mb-4 p-4" aria-label="Испытания">
        <h2 className="dash-label mb-2">Испытания по этому номеру</h2>
        {u.tests.length === 0
          ? <p className="dash-muted text-sm">Протоколов с этим серийным номером нет. Номер в протоколе испытания должен совпадать с номером экземпляра.</p>
          : (
            <ul className="text-sm">
              {u.tests.map(t => (
                <li key={t.id} className="dash-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <ResultChip r={t.result} />
                  <span className="dash-muted">{fmtDate(t.tested_on)} · {byUser(t.tester_id)?.name ?? '—'}</span>
                  <span className="min-w-0 flex-1 text-xs">
                    {t.measurements.filter(m => m.value !== null).map(m => (
                      <span key={m.name} className={`mr-3 tabular-nums ${outOfRange(m) ? 'text-[var(--d-danger)]' : 'dash-muted'}`}>{m.name}: {m.value}{m.unit ? ` ${m.unit}` : ''}</span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className="dash-card mb-4 p-4" aria-label="Состав сборки">
        <h2 className="dash-label mb-2">Что ушло на экземпляр</h2>
        {perUnit.length === 0
          ? <p className="dash-muted text-sm">Нет данных о списании.</p>
          : (
            <table className="w-full text-sm">
              <tbody>
                {perUnit.map(l => (
                  <tr key={l.component_id} className="dash-row">
                    <td className="py-1.5"><Link to={`/components/${l.component_id}`} className="hover:underline">{l.name}</Link></td>
                    <td className="py-1.5 text-right tabular-nums">{fmtQty(Math.round(l.per * 1000) / 1000)} {l.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        <p className="dash-muted mt-2 text-xs">Расчёт на один экземпляр из списания всей партии. Партии самих деталей (от какого поставщика, какого числа) система пока не различает.</p>
      </section>

      <section className="dash-card p-4" aria-label="Заметка">
        <Field label="Заметка">
          <textarea className="dash-input" rows={2} value={note ?? u.note} onChange={e => setNote(e.target.value)} maxLength={1000} />
        </Field>
        {note !== null && note !== u.note && (
          <div className="mt-2 flex justify-end"><button className="dash-btn dash-btn-sm" disabled={saveNote.isPending} onClick={() => saveNote.mutate()}>Сохранить</button></div>
        )}
      </section>
    </div>
  )
}

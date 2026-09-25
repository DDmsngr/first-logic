import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, GitCommitHorizontal, Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useWorkspace } from './auth'
import { updateProduct, type Product } from './catalog'
import { useCosting } from './catalogParts'
import { fmtDate, fmtDateTime, todayIso } from './meta'
import { fmtMoney, fmtQty, parseAmount } from './money'
import { RESULT_META, diffRevision, outOfRange, snapshot, testResult, type Measurement, type TestParam, type TestResult } from './quality'
import { createRevision, deleteRevision, deleteTest, fetchRevisions, fetchTests, saveTest, type ProductTest } from './stock'
import { DateInput, Field, Modal, QueryState, errMsg, useToast } from './ui'

export function ResultChip({ r }: { r: TestResult }) {
  const m = RESULT_META[r]
  return <span className="dash-chip" style={{ color: m.color, borderColor: `${m.color}66` }}>{m.label}</span>
}

const num = (s: string) => (s.trim() ? parseAmount(s) : null)
const fmtRange = (p: TestParam) => (p.min !== null && p.max !== null ? `${p.min}…${p.max}` : p.min !== null ? `≥ ${p.min}` : p.max !== null ? `≤ ${p.max}` : 'без допуска')

// ── испытания ───────────────────────────────────────────────────────────────

/** Протоколы испытаний изделия: шаблон измерений с допусками и записи по экземплярам. */
export function TestsPanel({ product: p }: { product: Product }) {
  const { byUser } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const tests = useQuery({ queryKey: ['tests', p.id], queryFn: () => fetchTests(p.id) })
  const [edit, setEdit] = useState<ProductTest | 'new' | null>(null)
  const [params, setParams] = useState(false)
  const del = useMutation({
    mutationFn: deleteTest,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tests', p.id] }); toast('Удалено') },
    onError: e => toast(errMsg(e), 'error'),
  })

  const all = tests.data ?? []
  const pass = all.filter(t => t.result === 'pass').length
  const fail = all.filter(t => t.result === 'fail').length

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="dash-btn dash-btn-sm" onClick={() => setEdit('new')}><Plus className="h-4 w-4" aria-hidden /> Испытание</button>
        <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setParams(true)}><SlidersHorizontal className="h-4 w-4" aria-hidden /> Шаблон измерений ({p.test_params.length})</button>
        {all.length > 0 && (
          <span className="dash-muted ml-auto text-sm tabular-nums">
            годных {pass} из {all.length}{fail > 0 && <span className="text-[var(--d-danger)]"> · брак {Math.round((fail / all.length) * 100)}%</span>}
          </span>
        )}
      </div>
      {p.test_params.length === 0 && <p className="dash-muted mb-2 text-sm">Задайте шаблон: что меряем и в каких пределах (мощность 95…110 Вт, КСВ ≤ 1,5). Тогда годен/брак считается сам.</p>}
      <QueryState loading={tests.isLoading} error={tests.error} onRetry={() => tests.refetch()} empty={all.length === 0} emptyText="Испытаний ещё не было">
        <ul className="text-sm">
          {all.map(t => (
            <li key={t.id} className="dash-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <ResultChip r={t.result} />
              <span className="dash-mono">{t.serial || '—'}</span>
              <span className="dash-muted">{fmtDate(t.tested_on)} · {byUser(t.tester_id)?.name ?? '—'}</span>
              <span className="min-w-0 flex-1 truncate text-xs">
                {t.measurements.filter(m => m.value !== null).map(m => (
                  <span key={m.name} className={`mr-3 tabular-nums ${outOfRange(m) ? 'text-[var(--d-danger)]' : 'dash-muted'}`}>{m.name}: {m.value}{m.unit ? ` ${m.unit}` : ''}</span>
                ))}
              </span>
              <span className="flex gap-1">
                <button className="dash-btn dash-btn-ghost dash-btn-sm !px-2" aria-label="Изменить" onClick={() => setEdit(t)}><Pencil className="h-3.5 w-3.5" aria-hidden /></button>
                <button className="dash-btn dash-btn-ghost dash-btn-sm !px-2" aria-label="Удалить" onClick={() => confirm(`Удалить испытание ${t.serial ?? ''}?`) && del.mutate(t.id)}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
              </span>
            </li>
          ))}
        </ul>
      </QueryState>

      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit === 'new' ? `Испытание: ${p.name}` : 'Испытание'}>
        {edit !== null && <TestForm product={p} test={edit === 'new' ? null : edit} onDone={() => { setEdit(null); qc.invalidateQueries({ queryKey: ['tests', p.id] }); qc.invalidateQueries({ queryKey: ['activity'] }) }} onCancel={() => setEdit(null)} />}
      </Modal>
      <Modal open={params} onClose={() => setParams(false)} title="Шаблон измерений">
        {params && <ParamsForm product={p} onDone={() => setParams(false)} />}
      </Modal>
    </div>
  )
}

function TestForm({ product: p, test, onDone, onCancel }: { product: Product; test: ProductTest | null; onDone: () => void; onCancel: () => void }) {
  const toast = useToast()
  // строки: из шаблона плюс то, что уже было в этом протоколе, но из шаблона пропало
  const base: TestParam[] = [...p.test_params, ...(test?.measurements ?? []).filter(m => !p.test_params.some(x => x.name === m.name))]
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(base.map(b => [b.name, String(test?.measurements.find(m => m.name === b.name)?.value ?? '')])))
  const [serial, setSerial] = useState(test?.serial ?? '')
  const [date, setDate] = useState(test?.tested_on ?? todayIso())
  const [note, setNote] = useState(test?.note ?? '')
  const ms: Measurement[] = base.map(b => ({ ...b, value: num(vals[b.name] ?? '') }))
  const bad = ms.find(m => m.value !== null && !Number.isFinite(m.value))
  const result = testResult(ms)

  const save = useMutation({
    mutationFn: () => saveTest(p.id, { serial: serial.trim() || null, tested_on: date || todayIso(), measurements: ms, note: note.trim() }, test?.id),
    onSuccess: () => { toast(`Сохранено: ${RESULT_META[result].label.toLowerCase()}`); onDone() },
    onError: e => toast(errMsg(e), 'error'),
  })
  const submit = (e: FormEvent) => { e.preventDefault(); if (bad) { toast(`«${bad.name}» — не число`, 'error'); return } save.mutate() }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Серийный номер / партия"><input className="dash-input dash-mono" autoFocus value={serial} onChange={e => setSerial(e.target.value)} placeholder="FL100-0012" /></Field>
        <Field label="Дата"><DateInput value={date} onChange={setDate} /></Field>
      </div>
      {base.length === 0
        ? <p className="dash-muted text-sm">Шаблон измерений пуст — задайте его кнопкой «Шаблон измерений», а пока можно записать просто заметку.</p>
        : (
          <div className="rounded-md border border-[var(--d-line)]">
            {ms.map(m => {
              const out = outOfRange(m)
              return (
                <label key={m.name} className="dash-row grid grid-cols-[1fr_7rem_6rem] items-center gap-2 px-3 py-1.5 text-sm">
                  <span>{m.name}{m.unit && <span className="dash-muted">, {m.unit}</span>}</span>
                  <input className={`dash-input !min-h-8 text-right ${out ? '!border-[var(--d-danger)] !text-[var(--d-danger)]' : ''}`} inputMode="decimal"
                    value={vals[m.name] ?? ''} onChange={e => setVals(v => ({ ...v, [m.name]: e.target.value }))} aria-label={m.name} />
                  <span className={`text-right text-xs tabular-nums ${out ? 'text-[var(--d-danger)]' : 'dash-muted'}`}>{fmtRange(m)}</span>
                </label>
              )
            })}
          </div>
        )}
      <Field label="Заметка"><textarea className="dash-input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Стенд, условия, что заменили" /></Field>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">Итог: <ResultChip r={result} /></span>
        <div className="flex gap-2">
          <button type="button" className="dash-btn dash-btn-ghost" onClick={onCancel}>Отмена</button>
          <button className="dash-btn" disabled={save.isPending}>Сохранить</button>
        </div>
      </div>
    </form>
  )
}

function ParamsForm({ product: p, onDone }: { product: Product; onDone: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [rows, setRows] = useState(() => (p.test_params.length ? p.test_params : [{ name: '', unit: '', min: null, max: null }])
    .map(r => ({ name: r.name, unit: r.unit ?? '', min: r.min === null ? '' : String(r.min), max: r.max === null ? '' : String(r.max) })))
  const upd = (i: number, k: 'name' | 'unit' | 'min' | 'max', v: string) => setRows(r => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  const save = useMutation({
    mutationFn: () => {
      const out: TestParam[] = rows.filter(r => r.name.trim()).map(r => ({ name: r.name.trim(), unit: r.unit.trim() || undefined, min: num(r.min), max: num(r.max) }))
      const bad = out.find(r => (r.min !== null && !Number.isFinite(r.min)) || (r.max !== null && !Number.isFinite(r.max)) || (r.min !== null && r.max !== null && r.min > r.max))
      if (bad) throw new Error(`«${bad.name}»: границы — числа, минимум не больше максимума`)
      if (new Set(out.map(r => r.name)).size !== out.length) throw new Error('Названия измерений должны быть разными')
      return updateProduct(p.id, { test_params: out })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['product', p.id] }); toast('Шаблон сохранён'); onDone() },
    onError: e => toast(errMsg(e), 'error'),
  })
  return (
    <form onSubmit={e => { e.preventDefault(); save.mutate() }} className="space-y-2">
      <div className="dash-label grid grid-cols-[1fr_4rem_5rem_5rem_2rem] gap-2"><span>Измерение</span><span>Ед.</span><span>Мин.</span><span>Макс.</span><span /></div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_4rem_5rem_5rem_2rem] gap-2">
          <input className="dash-input" placeholder="Выходная мощность" value={r.name} onChange={e => upd(i, 'name', e.target.value)} aria-label="Измерение" />
          <input className="dash-input" placeholder="Вт" value={r.unit} onChange={e => upd(i, 'unit', e.target.value)} aria-label="Единица" />
          <input className="dash-input text-right" inputMode="decimal" placeholder="—" value={r.min} onChange={e => upd(i, 'min', e.target.value)} aria-label="Минимум" />
          <input className="dash-input text-right" inputMode="decimal" placeholder="—" value={r.max} onChange={e => upd(i, 'max', e.target.value)} aria-label="Максимум" />
          <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !px-1" aria-label="Удалить строку" onClick={() => setRows(x => x.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
        </div>
      ))}
      <p className="dash-muted text-xs">Пустая граница — без ограничения с этой стороны. Уже записанные протоколы не меняются.</p>
      <div className="flex justify-between gap-2 pt-1">
        <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setRows(r => [...r, { name: '', unit: '', min: '', max: '' }])}><Plus className="h-4 w-4" aria-hidden /> Измерение</button>
        <button className="dash-btn" disabled={save.isPending}>Сохранить</button>
      </div>
    </form>
  )
}

// ── ревизии состава ─────────────────────────────────────────────────────────

type Parent = { productId: string; assemblyId?: never } | { assemblyId: string; productId?: never }

/** Зафиксировать текущий состав с ценами и сравнить с ним потом. */
export function RevisionsPanel({ parent }: { parent: Parent }) {
  const { byUser } = useWorkspace()
  const c = useCosting()
  const qc = useQueryClient()
  const toast = useToast()
  const revs = useQuery({ queryKey: ['revisions', parent.productId ?? parent.assemblyId], queryFn: () => fetchRevisions(parent) })
  const [open, setOpen] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const cost = c.k ? (parent.productId ? c.k.product(parent.productId) : c.k.assembly(parent.assemblyId!)) : null
  const unitOf = (id: string) => c.components.find(x => x.id === id)?.unit ?? 'шт'
  const now = cost ? snapshot(cost.lines, unitOf) : []

  const refresh = () => { qc.invalidateQueries({ queryKey: ['revisions'] }); qc.invalidateQueries({ queryKey: ['activity'] }) }
  const make = useMutation({
    mutationFn: () => createRevision(parent, label.trim() || `v${(revs.data?.length ?? 0) + 1}`, '', now, cost?.calculated ?? 0),
    onSuccess: () => { setLabel(''); refresh(); toast('Ревизия зафиксирована') },
    onError: e => toast(errMsg(e), 'error'),
  })
  const del = useMutation({ mutationFn: deleteRevision, onSuccess: refresh, onError: e => toast(errMsg(e), 'error') })

  return (
    <div className="mt-4 border-t border-[var(--d-line)] pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="dash-label mr-auto">Ревизии состава</h3>
        <input className="dash-input !min-h-8 !w-36" placeholder={`v${(revs.data?.length ?? 0) + 1}`} value={label} onChange={e => setLabel(e.target.value)} aria-label="Название ревизии" />
        <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={make.isPending || now.length === 0} onClick={() => make.mutate()}
          title="Сохранить текущий состав с ценами, чтобы потом сравнить"><GitCommitHorizontal className="h-4 w-4" aria-hidden /> Зафиксировать</button>
      </div>
      <QueryState loading={revs.isLoading} error={revs.error} onRetry={() => revs.refetch()} empty={revs.data?.length === 0}
        emptyText="Ревизий нет" emptyHint="Зафиксируйте состав перед изменениями — потом будет видно, что поменялось и во сколько обходилась прежняя версия">
        <ul className="text-sm">
          {revs.data?.map(r => {
            const d = open === r.id ? diffRevision(r.lines, now) : null
            return (
              <li key={r.id} className="dash-row py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button className="inline-flex items-center gap-1 font-medium hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                    <ChevronDown className={`h-4 w-4 transition-transform ${open === r.id ? '' : '-rotate-90'}`} aria-hidden />{r.label}
                  </button>
                  <span className="dash-muted">{fmtDateTime(r.created_at)} · {byUser(r.created_by)?.name ?? '—'} · {r.lines.length} поз.</span>
                  <span className="ml-auto tabular-nums">{fmtMoney(r.total_rub, 'RUB')}</span>
                  <button className="dash-btn dash-btn-ghost dash-btn-sm !px-2" aria-label="Удалить ревизию" onClick={() => confirm(`Удалить ревизию ${r.label}?`) && del.mutate(r.id)}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
                </div>
                {d && (
                  <div className="mt-2 rounded-md bg-black/20 p-3 text-xs">
                    <div className="mb-1.5 text-sm">
                      Сейчас <b className="tabular-nums">{fmtMoney(d.totalNow, 'RUB')}</b> против <span className="tabular-nums">{fmtMoney(d.totalWas, 'RUB')}</span>
                      <span className={`ml-2 tabular-nums ${d.totalNow > d.totalWas ? 'text-[var(--d-warn)]' : 'text-[var(--d-ok)]'}`}>
                        {d.totalNow >= d.totalWas ? '+' : ''}{fmtMoney(d.totalNow - d.totalWas, 'RUB')}
                      </span>
                    </div>
                    {!d.added.length && !d.removed.length && !d.changed.length && <p className="dash-muted">Состав не менялся.</p>}
                    {d.added.map(l => <div key={'a' + l.ref_id} className="text-[var(--d-ok)]">+ {l.name} × {fmtQty(l.qty)}</div>)}
                    {d.removed.map(l => <div key={'r' + l.ref_id} className="text-[var(--d-danger)]">− {l.name} × {fmtQty(l.qty)}</div>)}
                    {d.changed.map(ch => (
                      <div key={'c' + ch.now.ref_id} className="text-[var(--d-warn)]">
                        ~ {ch.now.name}: {ch.qty && `${fmtQty(ch.was.qty)} → ${fmtQty(ch.now.qty)} ${ch.now.unit}`}{ch.qty && ch.price && '; '}
                        {ch.price && `цена ${fmtMoney(ch.was.unit_rub, 'RUB')} → ${fmtMoney(ch.now.unit_rub, 'RUB')}`}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </QueryState>
    </div>
  )
}

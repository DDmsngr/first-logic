import { BomImportButton } from './bomImport'
import { CreateOrdersButton } from './orderCreate'
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Boxes, ChevronRight, Cpu, Pencil, Plus, Trash2 } from 'lucide-react'
import { addBomItem, deleteBomItem, updateBomItem, type BomPatch } from './catalog'
import { useWorkspace } from './auth'
import { MoneyInput, useCosting, useProducts, useRates, useSuppliers } from './catalogParts'
import { buildOrder, orderTotals, toCsv, toText } from './orders'
import { describeWarning, uniqueWarnings, type Cost, type Line } from './costing'
import { fmtMoney, fmtQty, parseAmount, type Currency } from './money'
import { Field, Modal, QueryState, errMsg, useToast } from './ui'

type Parent = { productId: string; assemblyId?: never } | { assemblyId: string; productId?: never }

const SOURCE: Record<Line['source'], string> = {
  component: 'цена из карточки компонента',
  line: 'своя цена в этой строке',
  calculated: 'расчёт по составу узла',
  override: 'ручная цена узла',
}

function useBomMutations() {
  const qc = useQueryClient()
  const toast = useToast()
  const refresh = () => { qc.invalidateQueries({ queryKey: ['bom'] }); qc.invalidateQueries({ queryKey: ['activity'] }) }
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: e => toast(errMsg(e), 'error'),
  })
  return run
}

/** Состав изделия или узла: строки, дерево узлов, итог, добавление позиций. */
export function BomEditor({ parent }: { parent: Parent }) {
  const c = useCosting()
  const [editing, setEditing] = useState<Line | null>(null)
  const cost: Cost | null = c.k ? (parent.productId ? c.k.product(parent.productId) : c.k.assembly(parent.assemblyId!)) : null
  const warnings = cost ? uniqueWarnings(cost.warnings) : []

  return (
    <QueryState loading={c.loading} error={c.error} onRetry={c.retry}>
      {cost && (
        <>
          {warnings.length > 0 && (
            <div role="status" className="mb-3 rounded-md border border-[var(--d-warn)]/40 bg-[var(--d-warn)]/5 px-3 py-2 text-xs text-[var(--d-warn)]">
              {warnings.map((w, i) => <div key={i} className="flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />{describeWarning(w)}</div>)}
            </div>
          )}

          {cost.lines.length === 0 ? (
            <p className="dash-muted py-4 text-center text-sm">Состав пуст. Добавьте компоненты и узлы — себестоимость посчитается сама.</p>
          ) : (
            <>
            <ul className="md:hidden">
              {cost.lines.map(l => <MobileRow key={l.item.id} line={l} onEdit={() => setEditing(l)} />)}
              <li className="flex items-baseline justify-between border-t border-[var(--d-line-strong)] pt-3">
                <span className="dash-label">Материалы, итого</span>
                <b className="text-base tabular-nums">{fmtMoney(cost.calculated, 'RUB')}</b>
              </li>
            </ul>
            <div className="-mx-4 hidden overflow-x-auto md:block">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="dash-label border-b border-[var(--d-line)] text-left">
                    <th className="py-2 pl-4 pr-2 font-medium">Позиция</th>
                    <th className="w-28 px-2 py-2 text-right font-medium">Кол-во</th>
                    <th className="px-2 py-2 text-right font-medium">Цена ед.</th>
                    <th className="px-2 py-2 text-right font-medium">Сумма</th>
                    <th className="w-20 py-2 pl-2 pr-4" />
                  </tr>
                </thead>
                <tbody>
                  {cost.lines.map(l => <Row key={l.item.id} line={l} depth={0} editable onEdit={() => setEditing(l)} />)}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[var(--d-line-strong)]">
                    <td colSpan={3} className="py-3 pl-4 pr-2 text-right text-xs uppercase tracking-wider text-[var(--d-muted)]">Материалы, итого</td>
                    <td className="px-2 py-3 text-right text-base font-semibold tabular-nums">{fmtMoney(cost.calculated, 'RUB')}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            </>
          )}

          <AddBomItem parent={parent} nextPosition={(cost.lines.at(-1)?.item.position ?? 0) + 1} existing={cost.lines} />
          <div className="mt-2 flex justify-end"><BomImportButton parent={parent} /></div>
          <EditLineModal line={editing} onClose={() => setEditing(null)} />
        </>
      )}
    </QueryState>
  )
}

function Row({ line: l, depth, editable, onEdit }: { line: Line; depth: number; editable?: boolean; onEdit?: () => void }) {
  const c = useCosting()
  const run = useBomMutations()
  const [open, setOpen] = useState(false)
  const [qty, setQty] = useState(String(l.item.qty))
  const comp = l.type === 'component' ? c.components.find(x => x.id === l.item.component_id) : undefined
  const children = l.type === 'assembly' && open && c.k ? c.k.assembly(l.item.child_assembly_id!).lines : []
  const unit = comp?.unit ?? 'шт'
  const href = l.type === 'component' ? `/components/${l.item.component_id}` : `/assemblies/${l.item.child_assembly_id}`

  const commitQty = () => {
    const n = parseAmount(qty)
    if (!Number.isFinite(n) || n <= 0) { setQty(String(l.item.qty)); return }
    if (n !== l.item.qty) run.mutate(() => updateBomItem(l.item.id, { qty: n }))
  }

  return (
    <>
      <tr className={`dash-row align-top ${depth ? 'bg-black/15 text-[13px]' : ''}`}>
        <td className="py-2.5 pl-4 pr-2">
          <div className="flex items-start gap-1.5" style={{ paddingLeft: depth * 18 }}>
            {l.type === 'assembly' && (c.k?.assembly(l.item.child_assembly_id!).lines.length ?? 0) > 0 ? (
              <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label={open ? 'Свернуть узел' : 'Раскрыть узел'}
                className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--d-muted)] hover:bg-[var(--d-raised)]">
                <ChevronRight className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
              </button>
            ) : <span className="w-5 shrink-0" />}
            {l.type === 'assembly'
              ? <Boxes className="mt-0.5 h-4 w-4 shrink-0 text-[var(--d-accent)]" aria-label="Узел" />
              : <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-[var(--d-muted)]" aria-label="Компонент" />}
            <div className="min-w-0">
              <Link to={href} className="font-medium hover:underline">{l.name}</Link>
              {l.item.note && <div className="dash-muted text-xs">{l.item.note}</div>}
            </div>
          </div>
        </td>
        <td className="px-2 py-2 text-right">
          {editable ? (
            <span className="inline-flex items-center gap-1">
              <input className="dash-input !min-h-8 !w-20 !px-2 text-right tabular-nums" inputMode="decimal" value={qty} aria-label={`Количество «${l.name}»`}
                onChange={e => setQty(e.target.value)} onBlur={commitQty} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
              <span className="dash-muted w-8 text-left text-xs">{unit}</span>
            </span>
          ) : <span className="tabular-nums">{fmtQty(l.item.qty)} <span className="dash-muted text-xs">{unit}</span></span>}
        </td>
        <td className="px-2 py-2.5 text-right tabular-nums" title={SOURCE[l.source]}>
          {l.unitRub === null ? <span className="text-[var(--d-warn)]">нет курса</span> : fmtMoney(l.unitRub, 'RUB')}
          {(l.source === 'line' || l.source === 'override') && <div className="text-[10px] uppercase tracking-wider text-[var(--d-warn)]">{l.source === 'line' ? 'своя' : 'ручная'}</div>}
          {l.source === 'component' && comp && comp.currency !== 'RUB' && <div className="dash-muted text-xs">{fmtMoney(comp.price, comp.currency)}</div>}
        </td>
        <td className="px-2 py-2.5 text-right font-medium tabular-nums">{fmtMoney(l.totalRub, 'RUB')}</td>
        <td className="py-2 pl-2 pr-4 text-right">
          {editable && (
            <span className="inline-flex gap-1">
              <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !px-2" onClick={onEdit} aria-label={`Изменить строку «${l.name}»`}><Pencil className="h-3.5 w-3.5" aria-hidden /></button>
              <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !px-2" aria-label={`Убрать «${l.name}» из состава`}
                onClick={() => confirm(`Убрать «${l.name}» из состава?`) && run.mutate(() => deleteBomItem(l.item.id))}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          )}
        </td>
      </tr>
      {children.map(ch => <Row key={ch.item.id} line={ch} depth={depth + 1} />)}
    </>
  )
}

/** Строка состава на телефоне: без таблицы, количество правится в окне. */
function MobileRow({ line: l, onEdit }: { line: Line; onEdit: () => void }) {
  const c = useCosting()
  const comp = l.type === 'component' ? c.components.find(x => x.id === l.item.component_id) : undefined
  const href = l.type === 'component' ? `/components/${l.item.component_id}` : `/assemblies/${l.item.child_assembly_id}`
  return (
    <li className="dash-row flex items-start gap-2 py-2.5 text-sm">
      {l.type === 'assembly'
        ? <Boxes className="mt-0.5 h-4 w-4 shrink-0 text-[var(--d-accent)]" aria-label="Узел" />
        : <Cpu className="dash-muted mt-0.5 h-4 w-4 shrink-0" aria-label="Компонент" />}
      <div className="min-w-0 flex-1">
        <Link to={href} className="font-medium hover:underline">{l.name}</Link>
        <div className="dash-muted text-xs tabular-nums">
          {fmtQty(l.item.qty)} {comp?.unit ?? 'шт'} × {l.unitRub === null ? 'нет курса' : fmtMoney(l.unitRub, 'RUB')}
          {l.source === 'line' && <span className="text-[var(--d-warn)]"> · своя цена</span>}
          {l.source === 'override' && <span className="text-[var(--d-warn)]"> · ручная</span>}
        </div>
      </div>
      <b className="shrink-0 tabular-nums">{fmtMoney(l.totalRub, 'RUB')}</b>
      <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !px-2" onClick={onEdit} aria-label={`Изменить строку «${l.name}»`}>
        <Pencil className="h-3.5 w-3.5" aria-hidden />
      </button>
    </li>
  )
}

function EditLineModal({ line, onClose }: { line: Line | null; onClose: () => void }) {
  return (
    <Modal open={!!line} onClose={onClose} title={line ? `Строка: ${line.name}` : ''}>
      {line && <EditLineForm key={line.item.id} line={line} onClose={onClose} />}
    </Modal>
  )
}

function EditLineForm({ line, onClose }: { line: Line; onClose: () => void }) {
  const run = useBomMutations()
  const toast = useToast()
  const it = line.item
  const [qty, setQty] = useState(String(it.qty))
  const [own, setOwn] = useState(it.price_override !== null)
  const [price, setPrice] = useState(it.price_override === null ? '' : String(it.price_override))
  const [cur, setCur] = useState<Currency>(it.price_currency)
  const [note, setNote] = useState(it.note)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const q = parseAmount(qty)
    if (!Number.isFinite(q) || q <= 0) { toast('Количество должно быть больше нуля', 'error'); return }
    const p = own ? parseAmount(price) : null
    if (own && (!Number.isFinite(p!) || p! < 0)) { toast('Цена должна быть неотрицательным числом', 'error'); return }
    const patch: BomPatch = { qty: q, price_override: p, price_currency: own ? cur : 'RUB', note: note.trim() }
    run.mutate(() => updateBomItem(it.id, patch), { onSuccess: () => { toast('Строка сохранена'); onClose() } })
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Количество"><input className="dash-input" inputMode="decimal" autoFocus value={qty} onChange={e => setQty(e.target.value)} /></Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 accent-[var(--d-accent)]" checked={own} onChange={e => setOwn(e.target.checked)} />
        <span>Своя цена в этой строке<span className="dash-muted block text-xs">
          Например, другой поставщик или партия. Без галочки — {line.type === 'component' ? 'цена из карточки компонента' : 'стоимость узла'}.
        </span></span>
      </label>
      {own && <MoneyInput label="Цена за единицу" amount={price} currency={cur} onAmount={setPrice} onCurrency={setCur} />}
      <Field label="Примечание"><input className="dash-input" value={note} onChange={e => setNote(e.target.value)} placeholder="Позиционное обозначение, вариант монтажа" /></Field>
      <div className="flex flex-wrap justify-between gap-2 pt-1">
        <button type="button" className="dash-btn dash-btn-ghost !text-[var(--d-danger)]" disabled={run.isPending}
          onClick={() => confirm(`Убрать «${line.name}» из состава?`) && run.mutate(() => deleteBomItem(it.id), { onSuccess: onClose })}>
          <Trash2 className="h-4 w-4" aria-hidden /> Убрать
        </button>
        <div className="flex gap-2">
          <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
          <button className="dash-btn" disabled={run.isPending}>Сохранить</button>
        </div>
      </div>
    </form>
  )
}

// ── добавление позиции ──────────────────────────────────────────────────────

type Option = { kind: 'component' | 'assembly'; id: string; name: string; hint: string }

function AddBomItem({ parent, nextPosition, existing }: { parent: Parent; nextPosition: number; existing: Line[] }) {
  const { workspace } = useWorkspace()
  const c = useCosting()
  const run = useBomMutations()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Option | null>(null)
  const [qty, setQty] = useState('1')

  const options = useMemo<Option[]>(() => {
    const forbidden = parent.assemblyId && c.k ? c.k.ancestors(parent.assemblyId) : new Set<string>()
    const taken = new Set(existing.map(l => l.item.component_id ?? l.item.child_assembly_id))
    return [
      ...c.assemblies.filter(a => !a.archived_at && !forbidden.has(a.id) && !taken.has(a.id))
        .map(a => ({ kind: 'assembly' as const, id: a.id, name: a.name, hint: a.sku ?? 'узел' })),
      ...c.components.filter(x => !x.archived_at && !taken.has(x.id))
        .map(x => ({ kind: 'component' as const, id: x.id, name: x.name, hint: [x.sku, x.manufacturer].filter(Boolean).join(' · ') })),
    ]
  }, [c.assemblies, c.components, c.k, parent.assemblyId, existing])

  const needle = q.trim().toLowerCase()
  const matches = needle ? options.filter(o => `${o.name} ${o.hint}`.toLowerCase().includes(needle)).slice(0, 8) : []

  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!picked) return
    const n = parseAmount(qty)
    if (!Number.isFinite(n) || n <= 0) { toast('Количество должно быть больше нуля', 'error'); return }
    run.mutate(() => addBomItem(workspace.id, {
      ...(parent.productId ? { parent_product_id: parent.productId } : { parent_assembly_id: parent.assemblyId }),
      ...(picked.kind === 'component' ? { component_id: picked.id } : { child_assembly_id: picked.id }),
      qty: n, position: nextPosition,
    }), { onSuccess: () => { setPicked(null); setQ(''); setQty('1') } })
  }

  return (
    <form onSubmit={add} className="mt-3 border-t border-[var(--d-line)] pt-3">
      <div className="dash-label mb-1.5">Добавить в состав</div>
      {picked ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="dash-chip !py-1 !text-sm !text-[var(--d-text)]">
            {picked.kind === 'assembly' ? <Boxes className="h-3.5 w-3.5 text-[var(--d-accent)]" aria-hidden /> : <Cpu className="h-3.5 w-3.5" aria-hidden />}
            {picked.name}
          </span>
          <input className="dash-input !w-24" inputMode="decimal" autoFocus value={qty} onChange={e => setQty(e.target.value)} aria-label="Количество" />
          <button className="dash-btn dash-btn-sm !min-h-10" disabled={run.isPending}><Plus className="h-4 w-4" aria-hidden /> Добавить</button>
          <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm !min-h-10" onClick={() => setPicked(null)}>Отмена</button>
        </div>
      ) : (
        <div className="relative">
          <input className="dash-input" placeholder="Начните вводить название компонента или узла" value={q} onChange={e => setQ(e.target.value)}
            aria-label="Поиск компонента или узла" aria-autocomplete="list" aria-controls="bom-options" />
          {needle && (
            <ul id="bom-options" role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-[var(--d-line-strong)] bg-[var(--d-raised)] p-1 shadow-xl">
              {matches.map(o => (
                <li key={o.kind + o.id} role="option" aria-selected={false}>
                  <button type="button" onClick={() => { setPicked(o); setQ('') }}
                    className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-[var(--d-surface)]">
                    {o.kind === 'assembly' ? <Boxes className="h-4 w-4 shrink-0 text-[var(--d-accent)]" aria-hidden /> : <Cpu className="dash-muted h-4 w-4 shrink-0" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    <span className="dash-muted dash-mono truncate text-xs">{o.hint}</span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && (
                <li className="dash-muted px-2 py-2 text-sm">
                  Не найдено. Создайте <Link className="underline" to="/components">компонент</Link> или <Link className="underline" to="/assemblies">узел</Link>.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </form>
  )
}

// ── потребность на партию ───────────────────────────────────────────────────

/** Сколько компонентов нужно на N штук и хватает ли склада. */
export function BatchNeeds({ parent, title = '' }: { parent: Parent; title?: string }) {
  const c = useCosting()
  const [count, setCount] = useState('1')
  const n = Math.max(1, Math.floor(parseAmount(count) || 1))
  const need = c.k ? c.k.explode(parent, n) : new Map<string, number>()
  const rows = [...need.entries()].map(([id, q]) => {
    const comp = c.components.find(x => x.id === id)
    return { id, q, comp, short: comp ? Math.max(0, q - Math.max(comp.stock, 0)) : q }
  }).sort((a, b) => b.short - a.short || (a.comp?.name ?? '').localeCompare(b.comp?.name ?? '', 'ru'))
  const shortCount = rows.filter(r => r.short > 0).length
  const canBuild = rows.length ? Math.min(...rows.map(r => Math.floor(Math.max(r.comp?.stock ?? 0, 0) / (r.q / n)))) : 0

  return (
    <QueryState loading={c.loading} error={c.error} onRetry={c.retry}>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-2">Партия
          <input className="dash-input !min-h-9 !w-20 text-right" inputMode="numeric" value={count} onChange={e => setCount(e.target.value)} aria-label="Размер партии" />
          шт
        </label>
        {rows.length > 0 && (
          <span className={shortCount ? 'text-[var(--d-warn)]' : 'text-[var(--d-ok)]'}>
            {shortCount ? `не хватает ${shortCount} позиций` : 'всё есть на складе'}
          </span>
        )}
        {rows.length > 0 && <span className="dash-muted">со склада можно собрать: <b className="text-[var(--d-text)] tabular-nums">{canBuild}</b> шт</span>}
      </div>
      {rows.length > 0 && <OrderExport need={need} sets={n} title={title} />}
      {rows.length === 0 ? <p className="dash-muted text-sm">Состав пуст — считать нечего.</p> : (
        <ul>
          {rows.map(r => (
            <li key={r.id} className="dash-row flex flex-wrap items-center gap-x-4 gap-y-0.5 py-2 text-sm">
              <Link to={`/components/${r.id}`} className="min-w-0 flex-1 basis-48 truncate hover:underline">{r.comp?.name ?? 'удалённый компонент'}</Link>
              <span className="w-24 text-right tabular-nums">нужно {fmtQty(r.q)}</span>
              <span className="dash-muted w-28 text-right tabular-nums">есть {fmtQty(r.comp?.stock ?? 0)}</span>
              <span className={`w-28 text-right font-medium tabular-nums ${r.short ? 'text-[var(--d-warn)]' : 'text-[var(--d-ok)]'}`}>
                {r.short ? `докупить ${fmtQty(r.short)}` : 'хватает'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </QueryState>
  )
}

// ── где используется ────────────────────────────────────────────────────────

export function UsedIn({ target }: { target: { componentId: string } | { assemblyId: string } }) {
  const c = useCosting()
  const { data: productsList } = useProducts()
  const rows = c.k ? c.k.usedIn(target) : []
  return (
    <QueryState loading={c.loading} error={c.error} onRetry={c.retry} empty={rows.length === 0} emptyText="Пока нигде не используется">
      <ul>
        {rows.map(i => {
          const isProduct = !!i.parent_product_id
          const name = isProduct
            ? productsList?.find(p => p.id === i.parent_product_id)?.name
            : c.assemblies.find(a => a.id === i.parent_assembly_id)?.name
          return (
            <li key={i.id} className="dash-row flex items-center gap-3 py-2 text-sm">
              {isProduct ? <span className="dash-chip">изделие</span> : <span className="dash-chip">узел</span>}
              <Link className="min-w-0 flex-1 truncate hover:underline" to={isProduct ? `/products/${i.parent_product_id}` : `/assemblies/${i.parent_assembly_id}`}>{name ?? '—'}</Link>
              <span className="tabular-nums">× {fmtQty(i.qty)}</span>
            </li>
          )
        })}
      </ul>
    </QueryState>
  )
}


// ── выгрузка для заказа ─────────────────────────────────────────────────────

const stamp = () => new Date().toISOString().slice(0, 10)

/** Список закупки на партию: что докупить с учётом склада; CSV для Excel и текст в буфер. */
function OrderExport({ need, sets, title }: { need: Map<string, number>; sets: number; title: string }) {
  const c = useCosting()
  const sups = useSuppliers()
  const rates = useRates()
  const toast = useToast()
  const [onlyShort, setOnlyShort] = useState(true)
  const [below, setBelow] = useState(false)
  const [belowN, setBelowN] = useState('5')

  const limit = below ? parseAmount(belowN) : null
  const supName = (id: string | null) => (id ? sups.data?.find(s => s.id === id)?.name ?? '' : '')
  const rows = buildOrder(need, c.components, supName, rates.data ?? [], {
    onlyShort, belowStock: limit !== null && Number.isFinite(limit) ? limit : null,
  })
  const t = orderTotals(rows)
  const heading = `Заказ${title ? `: ${title}` : ''} — ${sets} компл., ${new Date().toLocaleDateString('ru-RU')}`

  const download = () => {
    const blob = new Blob([toCsv(rows, heading)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Заказ ${title ? title.replace(/[\\/:*?"<>|]+/g, ' ').trim() + ' ' : ''}${sets} компл ${stamp()}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(toText(rows, heading)); toast('Список скопирован') }
    catch { toast('Не удалось скопировать — скачайте CSV', 'error') }
  }

  return (
    <div className="mb-4 rounded-lg border border-[var(--d-line)] bg-black/15 p-3" aria-label="Выгрузка для заказа">
      <div className="mb-2 text-sm font-medium">Выгрузить для заказа на {sets} компл.</div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-[var(--d-accent)]" checked={onlyShort} onChange={e => setOnlyShort(e.target.checked)} />
          Только то, чего не хватает
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-[var(--d-accent)]" checked={below} onChange={e => setBelow(e.target.checked)} />
          Только с остатком меньше
          <input className="dash-input !min-h-8 !w-16 text-right" inputMode="decimal" value={belowN} disabled={!below}
            onChange={e => setBelowN(e.target.value)} aria-label="Порог остатка" /> шт
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="dash-btn dash-btn-sm" disabled={rows.length === 0} onClick={download}>Скачать CSV (Excel)</button>
        <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={rows.length === 0} onClick={() => void copy()}>Скопировать список</button>
        <CreateOrdersButton rows={rows} />
        <span className="dash-muted text-xs tabular-nums">
          {rows.length === 0 ? 'Под условия ничего не подходит' : <>Позиций: {t.positions} · ≈ {fmtMoney(t.sumRub, 'RUB')}{t.withoutPrice > 0 && ` · без цены: ${t.withoutPrice}`}</>}
        </span>
      </div>
    </div>
  )
}

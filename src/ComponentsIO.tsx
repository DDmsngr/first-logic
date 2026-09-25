import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, FileDown, FileUp } from 'lucide-react'
import { createComponentsBulk, createSupplier, fetchAllComponents, updateComponent, type Component, type ComponentInput } from './catalog'
import { useWorkspace } from './auth'
import { useDicts, useRates, useSuppliers } from './catalogParts'
import { aiPrompt, buildTemplate, parseComponentFile, type ImportRow } from './componentJson'
import { fmtMoney, parseAmount } from './money'
import { buildOrder, orderTotals, toCsv, toText } from './orders'
import { saveText } from './download'
import { Modal, errMsg, useToast } from './ui'

const lc = (s: string) => s.trim().toLowerCase()

function saveJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Кнопка «Импорт» и окно загрузки компонентов из JSON (его составляет ИИ по прайсу или заявке). */
export default function ComponentsIO() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="dash-btn dash-btn-ghost" onClick={() => setOpen(true)}><FileUp className="h-4 w-4" aria-hidden /> Импорт</button>
      {open && <ImportModal onClose={() => setOpen(false)} />}
    </>
  )
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const { workspace } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const cats = useDicts('component_category')
  const sups = useSuppliers()
  const all = useQuery({ queryKey: ['components', workspace.id, 'all'], queryFn: () => fetchAllComponents(workspace.id) })
  const file = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [updatePrices, setUpdatePrices] = useState(false)
  const [done, setDone] = useState<{ created: number; updated: number; suppliers: number } | null>(null)

  const parsed = useMemo(() => (text.trim() ? parseComponentFile(text, {
    categories: cats.data ?? [], suppliers: sups.data ?? [],
    components: (all.data ?? []).map(c => ({ id: c.id, name: c.name, sku: c.sku })),
  }) : null), [text, cats.data, sups.data, all.data])

  const rows = parsed?.rows ?? []
  const okRows = rows.filter(r => r.errors.length === 0)
  const fresh = okRows.filter(r => r.duplicate === null)
  const existing = okRows.filter(r => r.duplicate === 'db')
  const toUpdate = updatePrices ? existing.filter(r => r.priceGiven) : []
  const newSuppliers = [...new Set(fresh.filter(r => r.newSupplier && r.supplierName).map(r => lc(r.supplierName!)))]
  const withoutPrice = fresh.filter(r => !r.priceGiven).length

  const copyPrompt = async () => {
    try { await navigator.clipboard.writeText(aiPrompt((cats.data ?? []).map(c => c.name))); toast('Подсказка скопирована — вставьте её в ИИ вместе с прайсом') }
    catch { toast('Не удалось скопировать', 'error') }
  }

  const run = useMutation({
    mutationFn: async () => {
      // 1) недостающие поставщики; 2) все новые компоненты одним запросом (всё или ничего); 3) цены у существующих
      const supIds = new Map<string, string>()
      for (const key of newSuppliers) {
        const name = fresh.find(r => r.supplierName && lc(r.supplierName) === key)!.supplierName!
        const s = await createSupplier(workspace.id, { name, contact: null, website: null, telegram: null, phone: null, email: null, notes: '' })
        supIds.set(key, s.id)
      }
      const inputs: ComponentInput[] = fresh.map(r => ({
        name: r.name, category_id: r.categoryId, sku: r.sku, manufacturer: r.manufacturer,
        supplier_id: r.supplierId ?? (r.supplierName ? supIds.get(lc(r.supplierName)) ?? null : null),
        url: r.url, unit: r.unit, price: r.price, currency: r.currency, stock: r.stock ?? 0, min_stock: r.minStock ?? 0,
        status: 'active', location: r.location, notes: r.notes,
      }))
      const created = await createComponentsBulk(workspace.id, inputs)
      let updated = 0
      for (const r of toUpdate) { await updateComponent(r.existingId!, { price: r.price, currency: r.currency }); updated++ }
      return { created, updated, suppliers: newSuppliers.length }
    },
    onSuccess: r => {
      setDone(r)
      for (const k of ['components', 'suppliers', 'activity', 'bom']) qc.invalidateQueries({ queryKey: [k] })
    },
    onError: e => toast(errMsg(e), 'error'),
  })

  const nothing = fresh.length === 0 && toUpdate.length === 0

  return (
    <Modal open onClose={onClose} title="Загрузить компоненты из JSON">
      {done ? (
        <div className="space-y-3">
          <p className="text-sm" role="status">
            Добавлено компонентов: <b>{done.created}</b>
            {done.updated > 0 && <>, обновлено цен: <b>{done.updated}</b></>}
            {done.suppliers > 0 && <>, создано поставщиков: <b>{done.suppliers}</b></>}.
          </p>
          {withoutPrice > 0 && <p className="dash-muted text-sm">У {withoutPrice} позиций цены нет: найдите их галочкой «Без цены» в списке и заполните.</p>}
          <div className="flex justify-end"><button className="dash-btn" onClick={onClose}>Готово</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <ol className="dash-muted list-decimal space-y-1 pl-5 text-sm">
            <li>Скопируйте подсказку и отдайте её любому ИИ вместе со своим прайсом или заявкой.</li>
            <li>ИИ вернёт JSON. Сохраните его в файл <span className="dash-mono">.json</span> или вставьте текстом ниже.</li>
            <li>Проверьте список и нажмите «Загрузить».</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => void copyPrompt()}><Copy className="h-4 w-4" aria-hidden /> Скопировать подсказку для ИИ</button>
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => saveJson('components-template.json', buildTemplate())}><FileDown className="h-4 w-4" aria-hidden /> Шаблон</button>
            <input ref={file} type="file" accept=".json,application/json,text/plain" className="sr-only" tabIndex={-1} aria-label="Файл JSON"
              onChange={async e => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = '' }} />
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => file.current?.click()}><FileUp className="h-4 w-4" aria-hidden /> Выбрать файл…</button>
          </div>
          <textarea className="dash-input font-mono text-xs" rows={4} aria-label="Или вставьте JSON сюда" placeholder='…или вставьте ответ ИИ сюда: {"components": [{"name": "…"}]}'
            value={text} onChange={e => setText(e.target.value)} />

          {parsed?.fatal && <p role="alert" className="text-sm text-[var(--d-danger)]">{parsed.fatal}</p>}

          {rows.length > 0 && (
            <>
              <ul className="max-h-72 overflow-y-auto rounded-xl border border-[var(--d-line)]" aria-label="Предпросмотр">
                {rows.map(r => <PreviewRow key={r.index} r={r} skipped={r.duplicate === 'db' && !(updatePrices && r.priceGiven)} />)}
              </ul>
              {existing.length > 0 && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 accent-[var(--d-accent)]" checked={updatePrices} onChange={e => setUpdatePrices(e.target.checked)} />
                  <span>Обновить цену у тех, что уже есть в справочнике ({existing.length})<span className="dash-muted block text-xs">Иначе они пропускаются. Остаток и остальные поля не меняются.</span></span>
                </label>
              )}
              <p className="dash-muted text-xs">
                Новых: {fresh.length}{newSuppliers.length > 0 && `, будет создано поставщиков: ${newSuppliers.length}`}
                {withoutPrice > 0 && `, без цены: ${withoutPrice}`}
                {rows.length - okRows.length > 0 && ` · строк с ошибками (пропущены): ${rows.length - okRows.length}`}
              </p>
            </>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
            <button className="dash-btn" disabled={nothing || run.isPending || all.isLoading} onClick={() => run.mutate()}>
              {run.isPending ? 'Загружаем…' : `Загрузить${fresh.length ? ` ${fresh.length}` : ''}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function PreviewRow({ r, skipped }: { r: ImportRow; skipped: boolean }) {
  const bad = r.errors.length > 0
  const tag = bad ? 'ошибка' : r.duplicate === 'db' ? (skipped ? 'уже есть, пропущу' : 'уже есть, обновлю цену') : r.duplicate === 'file' ? 'повтор в файле, пропущу' : 'новый'
  return (
    <li className={`dash-row px-3 py-2 text-sm ${bad || skipped || r.duplicate === 'file' ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="dash-muted dash-mono text-xs">{r.index}</span>
        <span className="min-w-0 flex-1 break-words font-medium">{r.name || '—'}</span>
        <span className={`dash-chip ${bad ? '!border-[var(--d-danger)] !text-[var(--d-danger)]' : ''}`}>{tag}</span>
        <span className="tabular-nums">{r.priceGiven ? fmtMoney(r.price, r.currency) : <span className="text-[var(--d-warn)]">нет цены</span>}</span>
      </div>
      <div className="dash-muted text-xs">
        {[r.categoryName, r.supplierName && `${r.supplierName}${r.newSupplier ? ' (новый)' : ''}`, r.sku].filter(Boolean).join(' · ')}
      </div>
      {r.errors.map((e, i) => <div key={i} className="text-xs text-[var(--d-danger)]">{e}</div>)}
      {r.warnings.filter(w => !w.startsWith('цена не указана')).map((w, i) => <div key={i} className="text-xs text-[var(--d-warn)]">{w}</div>)}
    </li>
  )
}


// ── выгрузка списка для заказа ──────────────────────────────────────────────

/**
 * Кнопка «Выгрузить»: берёт то, что сейчас показано в списке (с учётом фильтров —
 * поставщик, категория, «Заказать», «Без цены»), оставляет позиции с малым остатком
 * и считает, сколько докупить, чтобы довести остаток до нужного.
 */
export function OrderFromList({ items, scope = 'list' }: { items: Component[]; scope?: 'list' | 'selected' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="dash-btn dash-btn-ghost" onClick={() => setOpen(true)} disabled={items.length === 0}
        title={scope === 'selected' ? 'Выгрузить только отмеченные галочками' : 'Выгрузить список для заказа: то, что показано сейчас'}>
        <FileDown className="h-4 w-4" aria-hidden /> {scope === 'selected' ? `Выгрузить выбранные (${items.length})` : 'Выгрузить'}
      </button>
      {open && <OrderModal items={items} scope={scope} onClose={() => setOpen(false)} />}
    </>
  )
}

function OrderModal({ items, scope, onClose }: { items: Component[]; scope: 'list' | 'selected'; onClose: () => void }) {
  const sups = useSuppliers()
  const rates = useRates()
  const toast = useToast()
  // выбрали позиции руками — порог остатка по умолчанию не применяем: человек уже решил, что заказывать
  const [below, setBelow] = useState(scope === 'list')
  const [belowN, setBelowN] = useState('5')
  const [target, setTarget] = useState('10')

  const t = parseAmount(target)
  const limit = below ? parseAmount(belowN) : null
  const valid = Number.isFinite(t) && t > 0
  const supName = (id: string | null) => (id ? sups.data?.find(s => s.id === id)?.name ?? '' : '')
  const rows = valid ? buildOrder(new Map(items.map(c => [c.id, t])), items, supName, rates.data ?? [], {
    onlyShort: true, belowStock: limit !== null && Number.isFinite(limit) ? limit : null,
  }) : []
  const tot = orderTotals(rows)
  const heading = `Заказ${scope === 'selected' ? ' (выбранные позиции)' : ''}: довести остаток до ${target} шт — ${new Date().toLocaleDateString('ru-RU')}`

  const copy = async () => {
    try { await navigator.clipboard.writeText(toText(rows, heading)); toast('Список скопирован') }
    catch { toast('Не удалось скопировать — скачайте CSV', 'error') }
  }

  return (
    <Modal open onClose={onClose} title="Выгрузка для заказа">
      <div className="space-y-3">
        <p className="dash-muted text-sm">{scope === 'selected'
          ? <>Берутся <b>отмеченные галочками</b> позиции ({items.length}).</>
          : <>Берутся позиции, которые сейчас показаны в списке ({items.length}). Чтобы выгрузить только часть, отметьте нужные галочками или выберите поставщика в фильтрах.</>}</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-[var(--d-accent)]" checked={below} onChange={e => setBelow(e.target.checked)} />
          Только с остатком меньше
          <input className="dash-input !min-h-9 !w-16 text-right" inputMode="decimal" value={belowN} disabled={!below} onChange={e => setBelowN(e.target.value)} aria-label="Порог остатка" /> шт
        </label>
        <label className="flex items-center gap-2 text-sm">
          Докупить, чтобы на складе стало
          <input className="dash-input !min-h-9 !w-20 text-right" inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)} aria-label="Нужный остаток" /> шт
        </label>
        {!valid && <p className="text-sm text-[var(--d-danger)]" role="alert">Введите нужный остаток — число больше нуля.</p>}
        <p className="text-sm tabular-nums" role="status">
          {rows.length === 0 ? 'Под условия ничего не подходит.' : <>Позиций в заказе: <b>{tot.positions}</b> · ≈ <b>{fmtMoney(tot.sumRub, 'RUB')}</b>{tot.withoutPrice > 0 && <span className="text-[var(--d-warn)]"> · без цены: {tot.withoutPrice} (в итог не входят)</span>}</>}
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button className="dash-btn dash-btn-ghost" onClick={onClose}>Готово</button>
          <button className="dash-btn dash-btn-ghost" disabled={rows.length === 0} onClick={() => void copy()}>Скопировать список</button>
          <button className="dash-btn" disabled={rows.length === 0}
            onClick={() => saveText(`Заказ до ${target} шт ${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, heading))}>Скачать CSV (Excel)</button>
        </div>
      </div>
    </Modal>
  )
}

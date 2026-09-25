import { useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, FileUp } from 'lucide-react'
import { useWorkspace } from './auth'
import { addBomItemsBulk, createComponentsReturning, updateBomItem } from './catalog'
import { useCosting } from './catalogParts'
import { AI_PROMPT, parseBomFile, type BomImportRow } from './bomJson'
import { fmtQty } from './money'
import { Modal, errMsg, useToast } from './ui'

type Parent = { productId: string; assemblyId?: never } | { assemblyId: string; productId?: never }

/** Кнопка и окно: загрузить состав из JSON (его составляет ИИ по спецификации). */
export function BomImportButton({ parent }: { parent: Parent }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setOpen(true)}><FileUp className="h-4 w-4" aria-hidden /> Загрузить из JSON</button>
      {open && <BomImportModal parent={parent} onClose={() => setOpen(false)} />}
    </>
  )
}

function BomImportModal({ parent, onClose }: { parent: Parent; onClose: () => void }) {
  const { workspace } = useWorkspace()
  const c = useCosting()
  const qc = useQueryClient()
  const toast = useToast()
  const file = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [createMissing, setCreateMissing] = useState(true)
  const [replaceQty, setReplaceQty] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const existing = c.items.filter(i => (parent.productId ? i.parent_product_id === parent.productId : i.parent_assembly_id === parent.assemblyId))
  const inBom = new Set(existing.map(i => i.component_id ?? i.child_assembly_id!))
  const parsed = useMemo(() => (text.trim() ? parseBomFile(text, {
    components: c.components.filter(x => !x.archived_at).map(x => ({ id: x.id, name: x.name, sku: x.sku })),
    // узел нельзя вложить в самого себя и в тех, кто его содержит
    assemblies: c.assemblies.filter(a => !a.archived_at && !(parent.assemblyId && c.k?.ancestors(parent.assemblyId).has(a.id)))
      .map(a => ({ id: a.id, name: a.name, sku: a.sku })),
  }, inBom) : null), [text, c.components, c.assemblies, c.k, parent.assemblyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = parsed?.rows ?? []
  const ok = rows.filter(r => !r.errors.length)
  const matchedNew = ok.filter(r => r.match && !r.inBom)
  const already = ok.filter(r => r.match && r.inBom)
  const missing = ok.filter(r => !r.match)

  const copy = async () => {
    try { await navigator.clipboard.writeText(AI_PROMPT); toast('Подсказка скопирована — вставьте её в ИИ вместе со спецификацией') }
    catch { toast('Не удалось скопировать', 'error') }
  }

  const run = useMutation({
    mutationFn: async () => {
      let created: { id: string; name: string }[] = []
      if (createMissing && missing.length) {
        created = await createComponentsReturning(workspace.id, missing.map(r => ({
          name: r.name, category_id: null, sku: r.sku, manufacturer: null, supplier_id: null, url: null, unit: r.unit ?? 'шт',
          price: 0, currency: 'RUB', stock: 0, min_stock: 0, status: 'active', location: null, notes: 'Создан при загрузке состава',
        })))
      }
      let pos = Math.max(0, ...existing.map(i => i.position))
      const toAdd = [
        ...matchedNew.map(r => ({ r, kind: r.match!.kind, id: r.match!.id })),
        ...(createMissing ? missing.map((r, k) => ({ r, kind: 'component' as const, id: created[k]?.id })) : []),
      ].filter(x => x.id)
      await addBomItemsBulk(workspace.id, toAdd.map(x => ({
        ...(parent.productId ? { parent_product_id: parent.productId } : { parent_assembly_id: parent.assemblyId }),
        ...(x.kind === 'component' ? { component_id: x.id } : { child_assembly_id: x.id }),
        qty: x.r.qty, note: x.r.note, position: ++pos,
      })))
      let updated = 0
      if (replaceQty) {
        for (const r of already) {
          const line = existing.find(i => (i.component_id ?? i.child_assembly_id) === r.match!.id)
          if (line && line.qty !== r.qty) { await updateBomItem(line.id, { qty: r.qty }); updated++ }
        }
      }
      return `Добавлено в состав: ${toAdd.length}${created.length ? ` (из них новых компонентов: ${created.length})` : ''}${updated ? `, изменено количество: ${updated}` : ''}.`
    },
    onSuccess: msg => { setDone(msg); ['bom', 'components', 'activity'].forEach(k => qc.invalidateQueries({ queryKey: [k] })) },
    onError: e => toast(errMsg(e), 'error'),
  })

  const nothing = matchedNew.length === 0 && (!createMissing || missing.length === 0) && (!replaceQty || already.length === 0)

  return (
    <Modal open onClose={onClose} title="Загрузить состав из JSON" guard={!done}>
      {done ? (
        <div className="space-y-3">
          <p className="text-sm" role="status">{done}</p>
          {createMissing && missing.length > 0 && <p className="dash-muted text-sm">Новые компоненты созданы без цены — найдите их в «Компонентах» галочкой «Без цены».</p>}
          <div className="flex justify-end"><button className="dash-btn" onClick={onClose}>Готово</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <ol className="dash-muted list-decimal space-y-1 pl-5 text-sm">
            <li>Скопируйте подсказку и отдайте ИИ вместе со спецификацией, перечнем элементов или фото схемы.</li>
            <li>Вставьте ответ ниже. Детали найдутся в справочнике по артикулу или названию.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => void copy()}><Copy className="h-4 w-4" aria-hidden /> Скопировать подсказку для ИИ</button>
            <input ref={file} type="file" accept=".json,application/json,text/plain" className="sr-only" tabIndex={-1} aria-label="Файл JSON"
              onChange={async e => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = '' }} />
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => file.current?.click()}><FileUp className="h-4 w-4" aria-hidden /> Выбрать файл…</button>
          </div>
          <textarea className="dash-input font-mono text-xs" rows={4} aria-label="Или вставьте JSON сюда" placeholder='{"items": [{"name": "…", "sku": "…", "qty": 2}]}'
            value={text} onChange={e => setText(e.target.value)} />
          {parsed?.fatal && <p role="alert" className="text-sm text-[var(--d-danger)]">{parsed.fatal}</p>}

          {rows.length > 0 && (
            <>
              <ul className="max-h-64 overflow-y-auto rounded-xl border border-[var(--d-line)]" aria-label="Предпросмотр">
                {rows.map(r => <Preview key={r.index} r={r} createMissing={createMissing} replaceQty={replaceQty} />)}
              </ul>
              {missing.length > 0 && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 accent-[var(--d-accent)]" checked={createMissing} onChange={e => setCreateMissing(e.target.checked)} />
                  <span>Создать ненайденные компоненты ({missing.length})<span className="dash-muted block text-xs">Без цены и остатка — заполните потом. Иначе эти строки пропускаются.</span></span>
                </label>
              )}
              {already.length > 0 && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 accent-[var(--d-accent)]" checked={replaceQty} onChange={e => setReplaceQty(e.target.checked)} />
                  <span>Заменить количество у тех, что уже в составе ({already.length})<span className="dash-muted block text-xs">Иначе они пропускаются.</span></span>
                </label>
              )}
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
            <button className="dash-btn" disabled={nothing || run.isPending || c.loading} onClick={() => run.mutate()}>{run.isPending ? 'Загружаем…' : 'Загрузить'}</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Preview({ r, createMissing, replaceQty }: { r: BomImportRow; createMissing: boolean; replaceQty: boolean }) {
  const bad = r.errors.length > 0
  const tag = bad ? 'ошибка'
    : r.match ? (r.inBom ? (replaceQty ? 'заменю кол-во' : 'уже в составе') : r.match.kind === 'assembly' ? 'узел найден' : r.match.by === 'sku' ? 'найден по артикулу' : 'найден по названию')
    : createMissing ? 'создам компонент' : 'не найден, пропущу'
  const dim = bad || (r.inBom && !replaceQty) || (!r.match && !createMissing)
  return (
    <li className={`dash-row px-3 py-2 text-sm ${dim ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 flex-1 break-words font-medium">{r.name}</span>
        <span className="tabular-nums">× {fmtQty(r.qty)}</span>
        <span className={`dash-chip ${bad ? '!text-[var(--d-danger)]' : !r.match ? '!text-[var(--d-warn)]' : '!text-[var(--d-ok)]'}`}>{tag}</span>
      </div>
      {(r.match && r.match.name !== r.name) && <div className="dash-muted text-xs">→ {r.match.name}</div>}
      {(r.note || r.merged > 1) && <div className="dash-muted text-xs">{r.note}{r.merged > 1 && ` · объединено строк: ${r.merged}`}</div>}
      {r.errors.map((e, i) => <div key={i} className="text-xs text-[var(--d-danger)]">{e}</div>)}
    </li>
  )
}

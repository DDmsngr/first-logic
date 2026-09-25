import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { COMPONENT_STATUSES, UNITS, updateComponentsBulk, type ComponentInput } from './catalog'
import { useDicts, useSuppliers } from './catalogParts'
import { parseAmount } from './money'
import { Modal, errMsg, useToast } from './ui'

/** Строка «[галочка] Поле [ввод]». Вне компонента формы: иначе поле пересоздаётся при каждом вводе и теряет фокус. */
function Row({ label, checked, onToggle, children }: { label: string; checked: boolean; onToggle: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_9rem_1fr] items-center gap-2">
      <input type="checkbox" className="accent-[var(--d-accent)]" checked={checked} onChange={e => onToggle(e.target.checked)} aria-label={`Менять «${label}»`} />
      <span className={`text-sm ${checked ? '' : 'dash-muted'}`}>{label}</span>
      {children}
    </div>
  )
}

type Key = 'category_id' | 'supplier_id' | 'min_stock' | 'unit' | 'status' | 'location'

/** Изменить сразу у всех выбранных: меняются только отмеченные поля. */
export function BulkEditComponents({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const cats = useDicts('component_category')
  const sups = useSuppliers()
  const qc = useQueryClient()
  const toast = useToast()
  const [on, setOn] = useState<Record<Key, boolean>>({ category_id: false, supplier_id: false, min_stock: false, unit: false, status: false, location: false })
  const [v, setV] = useState({ category_id: '', supplier_id: '', min_stock: '', unit: 'шт', status: 'active', location: '' })
  const set = (k: Key, val: string) => { setV(x => ({ ...x, [k]: val })); setOn(x => ({ ...x, [k]: true })) }

  const run = useMutation({
    mutationFn: (patch: Partial<ComponentInput & { archived_at: string | null }>) => updateComponentsBulk(ids, patch),
    onSuccess: (n, patch) => {
      toast('archived_at' in patch ? `В архиве: ${n}` : `Изменено компонентов: ${n}`)
      qc.invalidateQueries({ queryKey: ['components'] }); qc.invalidateQueries({ queryKey: ['activity'] })
      onDone(); onClose()
    },
    onError: e => toast(errMsg(e), 'error'),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const patch: Partial<ComponentInput> = {}
    if (on.category_id) patch.category_id = v.category_id || null
    if (on.supplier_id) patch.supplier_id = v.supplier_id || null
    if (on.min_stock) {
      const n = v.min_stock.trim() ? parseAmount(v.min_stock) : 0
      if (!Number.isFinite(n) || n < 0) { toast('Минимальный остаток — неотрицательное число', 'error'); return }
      patch.min_stock = n
    }
    if (on.unit) patch.unit = v.unit.trim() || 'шт'
    if (on.status) patch.status = v.status as ComponentInput['status']
    if (on.location) patch.location = v.location.trim() || null
    if (!Object.keys(patch).length) { toast('Отметьте, что поменять', 'error'); return }
    run.mutate(patch)
  }

  return (
    <Modal open onClose={onClose} title={`Изменить выбранные: ${ids.length}`}>
      <form onSubmit={submit} className="space-y-2.5">
        <p className="dash-muted text-sm">Меняются только отмеченные поля — остальное у каждого компонента остаётся как было.</p>
        <Row label="Категория" checked={on.category_id} onToggle={c => setOn(o => ({ ...o, category_id: c }))}>
          <select className="dash-input" value={v.category_id} onChange={e => set('category_id', e.target.value)}>
            <option value="">Без категории</option>
            {cats.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Row>
        <Row label="Поставщик" checked={on.supplier_id} onToggle={c => setOn(o => ({ ...o, supplier_id: c }))}>
          <select className="dash-input" value={v.supplier_id} onChange={e => set('supplier_id', e.target.value)}>
            <option value="">Не указан</option>
            {sups.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Row>
        <Row label="Мин. остаток" checked={on.min_stock} onToggle={c => setOn(o => ({ ...o, min_stock: c }))}>
          <input className="dash-input" inputMode="decimal" placeholder="0 — не следить" value={v.min_stock} onChange={e => set('min_stock', e.target.value)} />
        </Row>
        <Row label="Единица" checked={on.unit} onToggle={c => setOn(o => ({ ...o, unit: c }))}>
          <>
            <input className="dash-input" list="fl-units-bulk" value={v.unit} onChange={e => set('unit', e.target.value)} />
            <datalist id="fl-units-bulk">{UNITS.map(u => <option key={u} value={u} />)}</datalist>
          </>
        </Row>
        <Row label="Статус" checked={on.status} onToggle={c => setOn(o => ({ ...o, status: c }))}>
          <select className="dash-input" value={v.status} onChange={e => set('status', e.target.value)}>
            {COMPONENT_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Row>
        <Row label="Место хранения" checked={on.location} onToggle={c => setOn(o => ({ ...o, location: c }))}>
          <input className="dash-input" placeholder="пусто — очистить" value={v.location} onChange={e => set('location', e.target.value)} />
        </Row>
        <div className="flex flex-wrap justify-between gap-2 pt-2">
          <button type="button" className="dash-btn dash-btn-ghost" disabled={run.isPending}
            onClick={() => confirm(`Убрать в архив ${ids.length} компонентов? Из составов они не пропадут, вернуть можно галочкой «Архив».`) && run.mutate({ archived_at: new Date().toISOString() })}>
            В архив
          </button>
          <div className="flex gap-2">
            <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
            <button className="dash-btn" disabled={run.isPending}>{run.isPending ? 'Сохраняем…' : 'Применить'}</button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

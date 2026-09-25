import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PackageCheck, Plus, Trash2, XCircle } from 'lucide-react'
import { useWorkspace } from './auth'
import { fmtDate, todayIso } from './meta'
import { parseSerials } from './serials'
import { UNIT_STATUS, addUnits, deleteUnit, fetchUnits, updateUnit, type Unit, type UnitStatus } from './stock'
import { DateInput, Field, Modal, QueryState, errMsg, useToast } from './ui'

export function UnitChip({ status }: { status: UnitStatus }) {
  const s = UNIT_STATUS[status]
  return <span className="dash-chip" style={{ color: s.color, borderColor: `${s.color}66` }}>{s.label}</span>
}

export const unitsRefresh = (qc: ReturnType<typeof useQueryClient>) =>
  ['units', 'unit', 'activity'].forEach(k => qc.invalidateQueries({ queryKey: [k] }))

/** Отгрузка экземпляра: кому и когда. */
export function ShipModal({ unit, onClose }: { unit: Unit | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [customer, setCustomer] = useState('')
  const [date, setDate] = useState(todayIso())
  const ship = useMutation({
    mutationFn: () => updateUnit(unit!.id, { status: 'shipped', customer: customer.trim(), shipped_on: date || null }),
    onSuccess: () => { toast(`Отгружен ${unit!.serial}`); unitsRefresh(qc); onClose() },
    onError: e => toast(errMsg(e), 'error'),
  })
  return (
    <Modal open={!!unit} onClose={onClose} title={unit ? `Отгрузка ${unit.serial}` : ''}>
      {unit && (
        <form onSubmit={e => { e.preventDefault(); ship.mutate() }} className="space-y-3">
          <Field label="Кому" hint="Клиент или заказ — по нему потом найдёте экземпляр при рекламации">
            <input className="dash-input" autoFocus value={customer} onChange={e => setCustomer(e.target.value)} maxLength={200} placeholder="ООО «Радиосвязь»" />
          </Field>
          <Field label="Дата отгрузки"><DateInput value={date} onChange={setDate} /></Field>
          <div className="flex justify-end gap-2">
            <button type="button" className="dash-btn dash-btn-ghost" onClick={onClose}>Отмена</button>
            <button className="dash-btn" disabled={ship.isPending}><PackageCheck className="h-4 w-4" aria-hidden /> Отгрузить</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

/** Действия над экземпляром: отгрузить, в брак, вернуть на склад, удалить ошибочный. */
export function UnitActions({ u }: { u: Unit }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [ship, setShip] = useState(false)
  const set = useMutation({
    mutationFn: (patch: Parameters<typeof updateUnit>[1]) => updateUnit(u.id, patch),
    onSuccess: () => unitsRefresh(qc),
    onError: e => toast(errMsg(e), 'error'),
  })
  const del = useMutation({
    mutationFn: () => deleteUnit(u.id),
    onSuccess: () => { toast('Удалено'); unitsRefresh(qc) },
    onError: e => toast(errMsg(e), 'error'),
  })
  return (
    <span className="flex flex-wrap gap-1">
      {u.status === 'in_stock' && <>
        <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setShip(true)}><PackageCheck className="h-4 w-4" aria-hidden /> Отгрузить</button>
        <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => confirm(`Списать ${u.serial} в брак?`) && set.mutate({ status: 'scrap' })}><XCircle className="h-4 w-4" aria-hidden /> В брак</button>
        {!u.build_id && <button className="dash-btn dash-btn-ghost dash-btn-sm !px-2" aria-label={`Удалить ${u.serial}`} onClick={() => confirm(`Удалить ${u.serial}?`) && del.mutate()}><Trash2 className="h-4 w-4" aria-hidden /></button>}
      </>}
      {u.status !== 'in_stock' && (
        <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => confirm(`Вернуть ${u.serial} на склад?`) && set.mutate({ status: 'in_stock' })}>Вернуть на склад</button>
      )}
      <ShipModal unit={ship ? u : null} onClose={() => setShip(false)} />
    </span>
  )
}

/** Экземпляры изделия: где какой номер и у кого. */
export function UnitsPanel({ productId }: { productId: string }) {
  const { byUser } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const q = useQuery({ queryKey: ['units', { productId }], queryFn: () => fetchUnits({ productId }) })
  const list = q.data ?? []
  const count = (s: UnitStatus) => list.filter(u => u.status === s).length

  const add = useMutation({
    mutationFn: () => addUnits(productId, parseSerials(text), note.trim()),
    onSuccess: () => { toast('Добавлено'); setAdding(false); setText(''); setNote(''); unitsRefresh(qc) },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="dash-muted text-sm">На складе {count('in_stock')} · отгружено {count('shipped')} · брак {count('scrap')}</span>
        <button className="dash-btn dash-btn-ghost dash-btn-sm ml-auto" onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden /> Добавить номера</button>
      </div>
      <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty={list.length === 0}
        emptyText="Экземпляров нет" emptyHint="Серийные номера присваиваются при сборке («Собрали»). Уже собранные раньше можно добавить кнопкой выше">
        <ul className="text-sm">
          {list.slice(0, 50).map(u => (
            <li key={u.id} className="dash-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <Link to={`/units/${u.id}`} className="dash-mono font-medium hover:underline">{u.serial}</Link>
              <UnitChip status={u.status} />
              <span className="dash-muted min-w-0 flex-1 truncate text-xs">
                {u.status === 'shipped' ? `${u.customer || '—'} · ${fmtDate(u.shipped_on)}` : u.note || `${byUser(u.created_by)?.name ?? '—'} · ${fmtDate(u.created_at)}`}
              </span>
              <UnitActions u={u} />
            </li>
          ))}
        </ul>
        {list.length > 50 && <p className="dash-muted mt-2 text-xs">Показаны последние 50 из {list.length}. <Link className="underline" to="/units">Все экземпляры</Link></p>}
      </QueryState>

      <Modal open={adding} onClose={() => setAdding(false)} title="Добавить экземпляры">
        <form onSubmit={e => { e.preventDefault(); add.mutate() }} className="space-y-3">
          <Field label="Серийные номера" hint="По одному на строку или через запятую">
            <textarea className="dash-input dash-mono" rows={5} autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={'FL100-0001\nFL100-0002'} />
          </Field>
          <Field label="Заметка"><input className="dash-input" value={note} onChange={e => setNote(e.target.value)} placeholder="Например, собраны до внедрения системы" /></Field>
          <div className="flex justify-end gap-2">
            <button type="button" className="dash-btn dash-btn-ghost" onClick={() => setAdding(false)}>Отмена</button>
            <button className="dash-btn" disabled={add.isPending || parseSerials(text).length === 0}>Добавить {parseSerials(text).length || ''}</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

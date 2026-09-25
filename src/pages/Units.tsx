import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fmtDate } from '../meta'
import { UNIT_STATUS, fetchUnits, type UnitStatus } from '../stock'
import { PageHeader, QueryState } from '../ui'
import { UnitActions, UnitChip } from '../units'

/** Все экземпляры по серийному номеру или клиенту: с этого начинается разбор рекламации. */
export default function Units() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<UnitStatus | ''>('')
  const q = useQuery({ queryKey: ['units', { search, status }], queryFn: () => fetchUnits({ search, status }), placeholderData: prev => prev })
  const list = q.data ?? []

  return (
    <>
      <PageHeader title="Экземпляры" sub="Серийные номера: когда собран, из чего, как испытан, кому отгружен." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input className="dash-input !w-auto min-w-52 flex-1" type="search" placeholder="Серийный номер или клиент" value={search} onChange={e => setSearch(e.target.value)} aria-label="Поиск" autoFocus />
        <div className="flex gap-1" role="tablist" aria-label="Статус">
          {([['', 'Все'], ...Object.entries(UNIT_STATUS).map(([k, v]) => [k, v.label])] as [string, string][]).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={status === k} onClick={() => setStatus(k as UnitStatus | '')} className={`dash-btn dash-btn-sm ${status === k ? '' : 'dash-btn-ghost'}`}>{l}</button>
          ))}
        </div>
      </div>
      <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty={list.length === 0}
        emptyText={search || status ? 'Ничего не найдено' : 'Экземпляров пока нет'} emptyHint="Номера присваиваются при сборке на странице изделия">
        <ul className="dash-card divide-y divide-[var(--d-line)]">
          {list.map(u => (
            <li key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
              <Link to={`/units/${u.id}`} className="dash-mono font-medium hover:underline">{u.serial}</Link>
              <UnitChip status={u.status} />
              <span className="min-w-0 flex-1 truncate">
                {u.product ? <Link to={`/products/${u.product.id}`} className="hover:underline">{u.product.name}{u.product.version ? ` ${u.product.version}` : ''}</Link> : '—'}
                <span className="dash-muted text-xs"> · {u.status === 'shipped' ? `${u.customer || '—'}, ${fmtDate(u.shipped_on)}` : `собран ${fmtDate(u.created_at)}`}</span>
              </span>
              <UnitActions u={u} />
            </li>
          ))}
        </ul>
        {list.length >= 500 && <p className="dash-muted mt-2 text-xs">Показаны первые 500 — уточните поиск.</p>}
      </QueryState>
    </>
  )
}

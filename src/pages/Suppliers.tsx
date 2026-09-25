import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, Mail, Phone, Plus, Send } from 'lucide-react'
import { createSupplier, fetchComponents } from '../catalog'
import { useWorkspace } from '../auth'
import { EMPTY_SUPPLIER, SupplierForm, useSuppliers } from '../catalogParts'
import { Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'

export default function Suppliers() {
  const { workspace } = useWorkspace()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [q, setQ] = useState('')

  const list = useSuppliers()
  const comps = useQuery({ queryKey: ['components', workspace.id, { archived: false }], queryFn: () => fetchComponents(workspace.id) })
  const countBy = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of comps.data ?? []) if (c.supplier_id) m.set(c.supplier_id, (m.get(c.supplier_id) ?? 0) + 1)
    return m
  }, [comps.data])

  const needle = q.trim().toLowerCase()
  const items = (list.data ?? []).filter(s =>
    !needle || [s.name, s.contact, s.email, s.telegram, s.phone, s.notes].some(v => v?.toLowerCase().includes(needle)))

  const create = useMutation({
    mutationFn: (s: typeof EMPTY_SUPPLIER) => createSupplier(workspace.id, s),
    onSuccess: s => { qc.invalidateQueries({ queryKey: ['suppliers'] }); setCreating(false); toast('Поставщик добавлен'); nav(`/suppliers/${s.id}`) },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <>
      <PageHeader title="Поставщики" sub={`${list.data?.length ?? 0} в справочнике`}
        actions={<button className="dash-btn" onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Новый поставщик</button>} />

      <input className="dash-input mb-4 max-w-md" type="search" placeholder="Название, контакт, email, Telegram" value={q}
        onChange={e => setQ(e.target.value)} aria-label="Поиск по поставщикам" />

      <QueryState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} empty={items.length === 0}
        emptyText={needle ? 'Ничего не найдено' : 'Поставщиков пока нет'} emptyHint={needle ? undefined : 'Добавьте первого — потом его можно выбрать в карточке компонента'}>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map(s => (
            <li key={s.id}>
              <Link to={`/suppliers/${s.id}`} className="dash-card block h-full p-4 transition-colors hover:border-[var(--d-line-strong)]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{s.name}</div>
                    <div className="dash-muted truncate text-xs">{s.contact || 'Контакт не указан'}</div>
                  </div>
                  <span className="dash-chip shrink-0">{countBy.get(s.id) ?? 0} комп.</span>
                </div>
                <div className="dash-muted mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {s.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" aria-hidden />{s.phone}</span>}
                  {s.telegram && <span className="inline-flex items-center gap-1"><Send className="h-3 w-3" aria-hidden />{s.telegram}</span>}
                  {s.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" aria-hidden />{s.email}</span>}
                  {s.website && <span className="inline-flex items-center gap-1"><Globe className="h-3 w-3" aria-hidden />{s.website.replace(/^https?:\/\//, '')}</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </QueryState>

      <Modal open={creating} onClose={() => setCreating(false)} title="Новый поставщик">
        {creating && <SupplierForm initial={EMPTY_SUPPLIER} submitLabel="Добавить" busy={create.isPending}
          onSubmit={s => create.mutate(s)} onCancel={() => setCreating(false)} />}
      </Modal>
    </>
  )
}

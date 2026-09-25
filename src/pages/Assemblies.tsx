import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Boxes, Plus } from 'lucide-react'
import { createAssembly, type AssemblyInput } from '../catalog'
import { useWorkspace } from '../auth'
import { AssemblyForm, EMPTY_ASSEMBLY, useCosting } from '../catalogParts'
import { uniqueWarnings } from '../costing'
import { fmtMoney } from '../money'
import { Modal, PageHeader, QueryState, errMsg, useToast } from '../ui'

export default function Assemblies() {
  const { workspace } = useWorkspace()
  const [sp, setSp] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const c = useCosting()

  const q = sp.get('q') ?? ''
  const archived = sp.get('archived') === '1'
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set(k, v); else n.delete(k)
    setSp(n, { replace: true })
  }

  const needle = q.trim().toLowerCase()
  const items = c.assemblies
    .filter(a => !!a.archived_at === archived && (!needle || [a.name, a.sku, a.description].some(v => v?.toLowerCase().includes(needle))))

  const create = useMutation({
    mutationFn: (a: AssemblyInput) => createAssembly(workspace.id, a),
    onSuccess: a => { qc.invalidateQueries({ queryKey: ['assemblies'] }); setCreating(false); toast('Узел добавлен'); nav(`/assemblies/${a.id}`) },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <>
      <PageHeader title="Узлы" sub="Сборочные единицы: из компонентов и других узлов. Стоимость считается по составу."
        actions={<button className="dash-btn" onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Новый узел</button>} />

      <div className="mb-4 flex flex-wrap gap-2">
        <input className="dash-input max-w-md flex-1" type="search" placeholder="Название, артикул" value={q}
          onChange={e => setParam('q', e.target.value)} aria-label="Поиск по узлам" />
        <label className="flex min-h-10 items-center gap-2 px-1 text-sm">
          <input type="checkbox" checked={archived} onChange={e => setParam('archived', e.target.checked ? '1' : '')} className="accent-[var(--d-accent)]" />
          Архив
        </label>
      </div>

      <QueryState loading={c.loading} error={c.error} onRetry={c.retry} empty={items.length === 0}
        emptyText={needle || archived ? 'Ничего не найдено' : 'Узлов пока нет'}
        emptyHint={needle || archived ? undefined : 'Например: блок питания 28 В, выходной каскад, радиаторная сборка'}>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {c.k && items.map(a => {
            const cost = c.k!.assembly(a.id)
            const used = c.k!.usedIn({ assemblyId: a.id }).length
            const warn = uniqueWarnings(cost.warnings).length
            return (
              <li key={a.id}>
                <Link to={`/assemblies/${a.id}`} className="dash-card flex h-full flex-col p-4 transition-colors hover:border-[var(--d-line-strong)]">
                  <div className="flex items-start gap-2">
                    <Boxes className="mt-0.5 h-4 w-4 shrink-0 text-[var(--d-accent)]" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{a.name}</div>
                      <div className="dash-muted dash-mono text-xs">{a.sku || '—'}</div>
                    </div>
                  </div>
                  {a.description && <p className="dash-muted mt-2 line-clamp-2 text-sm">{a.description}</p>}
                  <div className="mt-auto flex items-end justify-between gap-2 pt-4">
                    <div>
                      <div className="dash-label !text-[10px]">{cost.override !== null ? 'Стоимость (ручная)' : 'Стоимость'}</div>
                      <div className="text-lg font-semibold tabular-nums">{fmtMoney(cost.total, 'RUB')}</div>
                    </div>
                    <div className="dash-muted text-right text-xs">
                      {cost.lines.length} поз. · в {used} местах
                      {warn > 0 && <div className="inline-flex items-center gap-1 text-[var(--d-warn)]"><AlertTriangle className="h-3 w-3" aria-hidden />проверить цены</div>}
                    </div>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      </QueryState>

      <Modal open={creating} onClose={() => setCreating(false)} title="Новый узел">
        {creating && <AssemblyForm initial={EMPTY_ASSEMBLY} submitLabel="Добавить" busy={create.isPending}
          onSubmit={a => create.mutate(a)} onCancel={() => setCreating(false)} />}
      </Modal>
    </>
  )
}

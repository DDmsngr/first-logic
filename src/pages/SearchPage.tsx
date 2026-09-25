import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { search } from '../api'
import { useWorkspace } from '../auth'
import { statusMeta, fmtSize } from '../meta'
import { PageHeader, QueryState } from '../ui'

export default function SearchPage() {
  const q = useSearchParams()[0].get('q')?.trim() ?? ''
  const { workspace } = useWorkspace()
  const res = useQuery({ queryKey: ['search', workspace.id, q], queryFn: () => search(workspace.id, q), enabled: q.length >= 2 })
  const d = res.data
  const total = d ? d.tasks.length + d.members.length + d.messages.length + d.files.length
    + (d.components?.length ?? 0) + (d.suppliers?.length ?? 0) + (d.products?.length ?? 0) + (d.assemblies?.length ?? 0) : 0

  const Group = ({ title, children, n }: { title: string; children: React.ReactNode; n: number }) => n === 0 ? null : (
    <section className="dash-card mb-4 p-4" aria-label={title}><h2 className="dash-label mb-2">{title} · {n}</h2><ul>{children}</ul></section>
  )

  return (
    <>
      <PageHeader title="Поиск" sub={q ? `«${q}»` : 'Введите минимум 2 символа в строке сверху'} />
      {q.length >= 2 && (
        <QueryState loading={res.isLoading} error={res.error} onRetry={() => res.refetch()} empty={!!d && total === 0} emptyText="Ничего не найдено">
          <Group title="Задачи" n={d?.tasks.length ?? 0}>
            {d?.tasks.map(t => <li key={t.id} className="dash-row py-2"><Link className="text-sm hover:underline" to={`/tasks/${t.id}`}>#{t.num} {t.title}</Link> <span className="dash-muted text-xs">{statusMeta(t.status).label}</span></li>)}
          </Group>
          <Group title="Изделия" n={d?.products?.length ?? 0}>
            {d?.products?.map(p => <li key={p.id} className="dash-row py-2"><Link className="text-sm hover:underline" to={`/products/${p.id}`}>{p.name}{p.version ? ` ${p.version}` : ''}</Link> <span className="dash-muted dash-mono text-xs">{p.sku}</span></li>)}
          </Group>
          <Group title="Узлы" n={d?.assemblies?.length ?? 0}>
            {d?.assemblies?.map(a => <li key={a.id} className="dash-row py-2"><Link className="text-sm hover:underline" to={`/assemblies/${a.id}`}>{a.name}</Link> <span className="dash-muted dash-mono text-xs">{a.sku}</span></li>)}
          </Group>
          <Group title="Компоненты" n={d?.components?.length ?? 0}>
            {d?.components?.map(c => <li key={c.id} className="dash-row py-2"><Link className="text-sm hover:underline" to={`/components/${c.id}`}>{c.name}</Link> <span className="dash-muted text-xs">{[c.sku, c.manufacturer].filter(Boolean).join(' · ')}</span></li>)}
          </Group>
          <Group title="Поставщики" n={d?.suppliers?.length ?? 0}>
            {d?.suppliers?.map(s => <li key={s.id} className="dash-row py-2"><Link className="text-sm hover:underline" to={`/suppliers/${s.id}`}>{s.name}</Link> <span className="dash-muted text-xs">{s.contact}</span></li>)}
          </Group>
          <Group title="Люди" n={d?.members.length ?? 0}>
            {d?.members.map(m => <li key={m.user_id} className="dash-row py-2"><Link className="text-sm hover:underline" to={`/team/${m.user_id}`}>{m.name}</Link> <span className="dash-muted text-xs">{m.email}</span></li>)}
          </Group>
          <Group title="Сообщения" n={d?.messages.length ?? 0}>
            {d?.messages.map(m => <li key={m.id} className="dash-row py-2"><Link className="text-sm hover:underline" to={`/messages/${m.conversation_id}`}>{m.body.slice(0, 120)}</Link></li>)}
          </Group>
          <Group title="Файлы" n={d?.files.length ?? 0}>
            {d?.files.map(f => <li key={f.id} className="dash-row py-2"><Link className="text-sm hover:underline" to={f.task_id ? `/tasks/${f.task_id}` : f.component_id ? `/components/${f.component_id}` : f.supplier_id ? `/suppliers/${f.supplier_id}` : f.product_id ? `/products/${f.product_id}` : f.assembly_id ? `/assemblies/${f.assembly_id}` : '/files'}>{f.filename}</Link> <span className="dash-muted text-xs">{fmtSize(f.size)}</span></li>)}
          </Group>
        </QueryState>
      )}
    </>
  )
}

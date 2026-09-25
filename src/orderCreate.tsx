import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ShoppingCart } from 'lucide-react'
import { useWorkspace } from './auth'
import type { OrderRow } from './orders'
import { createOrder } from './stock'
import { errMsg, useToast } from './ui'

/** Из списка «что докупить» — черновики заказов, по одному на поставщика. */
export function CreateOrdersButton({ rows, onDone }: { rows: OrderRow[]; onDone?: () => void }) {
  const { workspace } = useWorkspace()
  const qc = useQueryClient()
  const nav = useNavigate()
  const toast = useToast()
  const groups = new Map<string, OrderRow[]>()
  for (const r of rows) if (r.order > 0) {
    const k = r.comp.supplier_id ?? ''
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const run = useMutation({
    mutationFn: async () => {
      const ids: string[] = []
      for (const [sup, list] of groups) {
        ids.push(await createOrder(workspace.id, sup || null, list.map(r => ({ component_id: r.comp.id, qty: r.order }))))
      }
      return ids
    },
    onSuccess: ids => {
      qc.invalidateQueries({ queryKey: ['orders'] })
      toast(ids.length === 1 ? 'Создан черновик заказа' : `Создано черновиков заказов: ${ids.length} (по поставщикам)`)
      onDone?.()
      nav(ids.length === 1 ? `/orders/${ids[0]}` : '/orders')
    },
    onError: e => toast(errMsg(e), 'error'),
  })
  const n = groups.size
  return (
    <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={n === 0 || run.isPending} onClick={() => run.mutate()}
      title="Черновики заказов: по одному на каждого поставщика">
      <ShoppingCart className="h-4 w-4" aria-hidden /> {run.isPending ? 'Создаём…' : n > 1 ? `Создать заказы (${n})` : 'Создать заказ'}
    </button>
  )
}

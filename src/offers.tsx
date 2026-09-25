import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { updateComponent, type Component } from './catalog'
import { MoneyInput, useRates, useSuppliers } from './catalogParts'
import { fmtDate } from './meta'
import { fmtMoney, parseAmount, toRub, type Currency } from './money'
import { deleteOffer, fetchOffers, saveOffer, type Offer, type OfferInput } from './stock'
import { Field, Modal, QueryState, errMsg, useToast } from './ui'

/**
 * Цены у разных поставщиков. Основная цена и поставщик — в самой карточке
 * компонента (по ним считается себестоимость); остальные — для сравнения,
 * и любое можно сделать основным.
 */
export function OffersPanel({ c }: { c: Component }) {
  const qc = useQueryClient()
  const toast = useToast()
  const sups = useSuppliers()
  const rates = useRates()
  const offers = useQuery({ queryKey: ['offers', c.id], queryFn: () => fetchOffers(c.id) })
  const [edit, setEdit] = useState<Offer | 'new' | null>(null)

  const refresh = () => { qc.invalidateQueries({ queryKey: ['offers', c.id] }); qc.invalidateQueries({ queryKey: ['component', c.id] }); qc.invalidateQueries({ queryKey: ['components'] }) }
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: refresh, onError: e => toast(errMsg(e), 'error') })

  const name = (id: string | null) => sups.data?.find(s => s.id === id)?.name ?? '—'
  const rub = (price: number, cur: Currency) => (price > 0 ? toRub(price, cur, rates.data ?? []) : null)
  // основная цена (из карточки) + предложения, без повтора основного поставщика
  const rows = [
    ...(c.supplier_id || c.price > 0 ? [{ key: 'main', supplierId: c.supplier_id, price: c.price, currency: c.currency, main: true, offer: null as Offer | null }] : []),
    ...(offers.data ?? []).filter(o => !(o.supplier_id === c.supplier_id && o.price === c.price && o.currency === c.currency))
      .map(o => ({ key: o.id, supplierId: o.supplier_id as string | null, price: o.price, currency: o.currency, main: false, offer: o as Offer | null })),
  ]
  const priced = rows.map(r => rub(r.price, r.currency)).filter((x): x is number => x !== null)
  const best = priced.length > 1 ? Math.min(...priced) : null

  return (
    <div>
      <QueryState loading={offers.isLoading} error={offers.error} onRetry={() => offers.refetch()} empty={rows.length === 0}
        emptyText="Цен от поставщиков пока нет" emptyHint="Добавьте, у кого и почём можно купить — сравнение и выбор основного здесь">
        <ul className="text-sm">
          {rows.map(r => {
            const inRub = rub(r.price, r.currency)
            return (
              <li key={r.key} className="dash-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="min-w-0 flex-1 basis-40 truncate">
                  {r.supplierId ? <Link className="hover:underline" to={`/suppliers/${r.supplierId}`}>{name(r.supplierId)}</Link> : <span className="dash-muted">поставщик не указан</span>}
                  {r.main && <span className="dash-chip ml-2 !py-0 !text-[var(--d-accent)]">основной</span>}
                  {best !== null && inRub === best && <span className="dash-chip ml-1 !py-0 !text-[var(--d-ok)]">дешевле всех</span>}
                  {r.offer?.lead_time && <span className="dash-muted ml-2 text-xs">срок: {r.offer.lead_time}</span>}
                </span>
                <span className="text-right tabular-nums">
                  {r.price > 0 ? fmtMoney(r.price, r.currency) : <span className="dash-muted">нет цены</span>}
                  {r.currency !== 'RUB' && inRub !== null && <span className="dash-muted block text-xs">≈ {fmtMoney(inRub, 'RUB')}</span>}
                </span>
                <span className="flex gap-1">
                  {r.offer?.url && <a className="dash-btn dash-btn-ghost dash-btn-sm !px-2" href={r.offer.url} target="_blank" rel="noopener noreferrer" aria-label="Открыть товар"><ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>}
                  {r.offer && (
                    <>
                      <button className="dash-btn dash-btn-ghost dash-btn-sm !px-2" title="Сделать основным: цена и поставщик перейдут в карточку, себестоимость пересчитается"
                        aria-label="Сделать основным" disabled={run.isPending}
                        onClick={() => run.mutate(() => updateComponent(c.id, { supplier_id: r.offer!.supplier_id, price: r.offer!.price, currency: r.offer!.currency }),
                          { onSuccess: () => toast(`Основной поставщик: ${name(r.offer!.supplier_id)}`) })}>
                        <Star className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button className="dash-btn dash-btn-ghost dash-btn-sm !px-2" aria-label="Изменить" onClick={() => setEdit(r.offer)}><Pencil className="h-3.5 w-3.5" aria-hidden /></button>
                      <button className="dash-btn dash-btn-ghost dash-btn-sm !px-2" aria-label="Удалить"
                        onClick={() => confirm(`Удалить цену ${name(r.offer!.supplier_id)}?`) && run.mutate(() => deleteOffer(r.offer!.id))}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </QueryState>
      <button className="dash-btn dash-btn-ghost dash-btn-sm mt-2" onClick={() => setEdit('new')}><Plus className="h-4 w-4" aria-hidden /> Цена поставщика</button>
      {offers.data?.length ? <p className="dash-muted mt-1 text-xs">Обновлено: {fmtDate(offers.data.map(o => o.updated_at).sort().at(-1))}</p> : null}

      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit === 'new' ? 'Цена поставщика' : 'Изменить цену'}>
        {edit !== null && <OfferForm c={c} offer={edit === 'new' ? null : edit} taken={(offers.data ?? []).map(o => o.supplier_id)}
          onDone={() => { setEdit(null); refresh() }} onCancel={() => setEdit(null)} />}
      </Modal>
    </div>
  )
}

function OfferForm({ c, offer, taken, onDone, onCancel }: {
  c: Component; offer: Offer | null; taken: string[]; onDone: () => void; onCancel: () => void
}) {
  const sups = useSuppliers()
  const toast = useToast()
  const [f, setF] = useState({
    supplier: offer?.supplier_id ?? '', price: offer?.price ? String(offer.price) : '', currency: (offer?.currency ?? c.currency) as Currency,
    sku: offer?.sku ?? '', url: offer?.url ?? '', lead: offer?.lead_time ?? '', note: offer?.note ?? '',
  })
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))
  const save = useMutation({
    mutationFn: () => {
      const p = f.price.trim() ? parseAmount(f.price) : 0
      if (!Number.isFinite(p) || p < 0) throw new Error('Цена — неотрицательное число')
      if (!f.supplier) throw new Error('Выберите поставщика')
      const input: OfferInput = { supplier_id: f.supplier, price: p, currency: f.currency, sku: f.sku.trim() || null,
        url: /^https?:\/\//i.test(f.url.trim()) ? f.url.trim() : null, lead_time: f.lead.trim() || null, note: f.note }
      return saveOffer(c.id, input, offer?.id)
    },
    onSuccess: () => { toast('Сохранено'); onDone() },
    onError: e => toast(/duplicate|unique/i.test(errMsg(e)) ? 'У этого поставщика цена уже есть — измените её' : errMsg(e), 'error'),
  })
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate() }
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field label="Поставщик">
          <select className="dash-input" value={f.supplier} onChange={e => set('supplier')(e.target.value)} disabled={!!offer}>
            <option value="">Выберите…</option>
            {sups.data?.filter(s => s.id === offer?.supplier_id || !taken.includes(s.id)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        {!sups.data?.length && <p className="dash-muted mt-1 text-xs">Поставщиков ещё нет — добавьте в разделе «Поставщики».</p>}
      </div>
      <MoneyInput label="Цена за единицу" amount={f.price} currency={f.currency} onAmount={set('price')} onCurrency={set('currency')} />
      <Field label="Срок поставки"><input className="dash-input" placeholder="in stock, 2 дня, неделя" value={f.lead} onChange={e => set('lead')(e.target.value)} /></Field>
      <Field label="Артикул у поставщика"><input className="dash-input" value={f.sku} onChange={e => set('sku')(e.target.value)} /></Field>
      <Field label="Ссылка на товар"><input className="dash-input" type="url" placeholder="https://" value={f.url} onChange={e => set('url')(e.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label="Примечание"><input className="dash-input" placeholder="минимальная партия, доставка" value={f.note} onChange={e => set('note')(e.target.value)} /></Field></div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <button type="button" className="dash-btn dash-btn-ghost" onClick={onCancel}>Отмена</button>
        <button className="dash-btn" disabled={save.isPending}>Сохранить</button>
      </div>
    </form>
  )
}

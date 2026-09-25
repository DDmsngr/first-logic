import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { fetchAttachments, isImage, signedUrl } from '../api'
import { useWorkspace } from '../auth'
import { fetchProduct, sellingPrice } from '../catalog'
import { fmtMoney, parseAmount, type Currency } from '../money'
import { Field, QueryState } from '../ui'

const today = () => new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) }

/** Настройки КП живут в браузере: при следующем КП на это изделие подставятся. */
function useSaved<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s ? { ...initial, ...JSON.parse(s) } : initial } catch { return initial }
  })
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* без хранилища — просто не запомним */ } }, [key, v])
  return [v, setV] as const
}

export default function ProductOffer() {
  const { id = '' } = useParams()
  const { me } = useWorkspace()
  const q = useQuery({ queryKey: ['product', id], queryFn: () => fetchProduct(id) })
  const files = useQuery({ queryKey: ['attachments', 'product', id], queryFn: () => fetchAttachments({ productId: id }) })
  const photo = files.data?.find(isImage)
  const photoUrl = useQuery({ queryKey: ['img-url', photo?.id], queryFn: () => signedUrl(photo!.storage_path, undefined, 3600), enabled: !!photo, staleTime: 50 * 60_000 })

  const p = q.data
  const [f, setF] = useSaved(`fl-offer-${id}`, {
    client: '', qty: '1', price: '', discount: '', validDays: '14', delivery: 'до 30 рабочих дней', payment: '50% предоплата, 50% перед отгрузкой',
    warranty: '12 месяцев', note: '', contacts: '',
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  if (!p) return <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty emptyText="Изделие не найдено"><></></QueryState>

  const cur: Currency = p.price_currency
  const unit = f.price.trim() ? parseAmount(f.price) : sellingPrice(p) ?? 0
  const qty = Math.max(1, Math.floor(parseAmount(f.qty) || 1))
  const disc = Math.min(100, Math.max(0, parseAmount(f.discount) || 0))
  const total = unit * qty * (1 - disc / 100)
  const num = `КП-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${(p.sku ?? p.name).replace(/[^A-Za-z0-9А-Яа-я]/g, '').slice(0, 8).toUpperCase()}`
  const contacts = f.contacts || [me.name, me.position, me.phone, me.email].filter(Boolean).join(' · ')

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link to={`/products/${p.id}`} className="dash-muted inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> {p.name}</Link>
        <button className="dash-btn" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden /> Печать / сохранить в PDF</button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[300px_1fr] print:block">
        <aside className="dash-card space-y-3 p-4 print:hidden" aria-label="Настройки КП">
          <h2 className="dash-label">Настройки предложения</h2>
          <Field label="Кому"><input className="dash-input" placeholder="ООО «Заказчик», Иванову И. И." value={f.client} onChange={set('client')} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Кол-во, шт"><input className="dash-input" inputMode="numeric" value={f.qty} onChange={set('qty')} /></Field>
            <Field label="Скидка, %"><input className="dash-input" inputMode="decimal" placeholder="0" value={f.discount} onChange={set('discount')} /></Field>
          </div>
          <Field label={`Цена за шт, ${cur}`} hint="Пусто — цена из карточки изделия"><input className="dash-input" inputMode="decimal" placeholder={String(sellingPrice(p) ?? '')} value={f.price} onChange={set('price')} /></Field>
          <Field label="Действует, дней"><input className="dash-input" inputMode="numeric" value={f.validDays} onChange={set('validDays')} /></Field>
          <Field label="Срок поставки"><input className="dash-input" value={f.delivery} onChange={set('delivery')} /></Field>
          <Field label="Оплата"><input className="dash-input" value={f.payment} onChange={set('payment')} /></Field>
          <Field label="Гарантия"><input className="dash-input" value={f.warranty} onChange={set('warranty')} /></Field>
          <Field label="Примечание"><textarea className="dash-input" rows={3} value={f.note} onChange={set('note')} /></Field>
          <Field label="Контакты" hint="Пусто — ваши данные из профиля"><input className="dash-input" placeholder={contacts} value={f.contacts} onChange={set('contacts')} /></Field>
          <p className="dash-muted text-xs">В окне печати выберите «Сохранить как PDF». Настройки запоминаются для этого изделия.</p>
        </aside>

        {/* лист A4 — светлый, как на бумаге */}
        <article className="offer-sheet mx-auto w-full max-w-[794px] rounded-md bg-white p-10 text-[#16202a] shadow-2xl print:max-w-none print:rounded-none print:p-0 print:shadow-none"
          style={{ fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
          <header className="flex items-start justify-between gap-6 border-b-2 border-[#16202a] pb-4">
            <div className="flex items-center gap-3">
              <svg viewBox="0 0 32 32" className="h-11 w-11" aria-hidden>
                <rect width="32" height="32" rx="6" fill="#0a0d11" />
                <path d="M9 23V9h10M9 16h7" fill="none" stroke="#2a9fc4" strokeWidth="2.6" strokeLinecap="square" />
                <path d="M21 9v14h4" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="square" />
              </svg>
              <div>
                <div className="text-xl font-bold tracking-tight">First Logic</div>
                <div className="text-[11px] uppercase tracking-[0.14em] text-[#5b6773]">Усилители мощности · разработка и производство</div>
              </div>
            </div>
            <div className="text-right text-sm">
              <div className="font-semibold">Коммерческое предложение</div>
              <div className="text-[#5b6773]">№ {num}</div>
              <div className="text-[#5b6773]">от {today()}</div>
            </div>
          </header>

          {f.client && <p className="mt-5 text-sm"><span className="text-[#5b6773]">Для: </span><b>{f.client}</b></p>}

          <section className="mt-5 grid gap-6" style={{ gridTemplateColumns: photoUrl.data ? '1fr 220px' : '1fr' }}>
            <div>
              <h1 className="text-2xl font-bold leading-tight">{p.name}{p.version ? ` ${p.version}` : ''}</h1>
              {p.sku && <div className="mt-1 font-mono text-xs text-[#5b6773]">Артикул: {p.sku}</div>}
              {p.description && <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{p.description}</p>}
            </div>
            {photoUrl.data && <img src={photoUrl.data} alt={p.name} className="h-[180px] w-[220px] rounded-md border border-[#d7dde3] object-cover" />}
          </section>

          {p.specs.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5b6773]">Технические характеристики</h2>
              <table className="w-full border-collapse text-sm">
                <tbody>
                  {p.specs.map((s, i) => (
                    <tr key={i} className={i % 2 ? '' : 'bg-[#f3f5f7]'}>
                      <td className="border-b border-[#e3e7eb] px-3 py-1.5 text-[#39434d]">{s.name}</td>
                      <td className="border-b border-[#e3e7eb] px-3 py-1.5 text-right font-medium tabular-nums">{s.value}{s.unit ? ` ${s.unit}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="mt-6">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5b6773]">Стоимость</h2>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b-2 border-[#16202a] text-left text-[11px] uppercase tracking-wider text-[#5b6773]">
                  <th className="py-1.5 pr-2 font-semibold">Наименование</th><th className="px-2 py-1.5 text-right font-semibold">Кол-во</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Цена</th>{disc > 0 && <th className="px-2 py-1.5 text-right font-semibold">Скидка</th>}
                  <th className="py-1.5 pl-2 text-right font-semibold">Сумма</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-[#e3e7eb]">
                  <td className="py-2 pr-2">{p.name}{p.version ? ` ${p.version}` : ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{qty} шт</td>
                  <td className="px-2 py-2 text-right tabular-nums">{unit > 0 ? fmtMoney(unit, cur) : 'по запросу'}</td>
                  {disc > 0 && <td className="px-2 py-2 text-right tabular-nums">{disc}%</td>}
                  <td className="py-2 pl-2 text-right font-semibold tabular-nums">{unit > 0 ? fmtMoney(total, cur) : '—'}</td>
                </tr>
              </tbody>
            </table>
            {unit > 0 && <p className="mt-2 text-right text-lg font-bold tabular-nums">Итого: {fmtMoney(total, cur)}</p>}
          </section>

          <section className="mt-6 grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
            {[['Срок поставки', f.delivery], ['Условия оплаты', f.payment], ['Гарантия', f.warranty], ['Предложение действует до', plusDays(Math.max(1, parseAmount(f.validDays) || 14))]]
              .filter(([, v]) => v).map(([k, v]) => (
                <div key={k}><div className="text-[11px] uppercase tracking-wider text-[#5b6773]">{k}</div><div>{v}</div></div>
              ))}
          </section>
          {f.note && <p className="mt-5 whitespace-pre-wrap text-sm">{f.note}</p>}

          <footer className="mt-10 border-t border-[#d7dde3] pt-3 text-xs text-[#5b6773]">
            {contacts}
          </footer>
        </article>
      </div>
    </div>
  )
}

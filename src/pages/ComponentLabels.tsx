import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import qrcode from 'qrcode-generator'
import { ArrowLeft, Printer } from 'lucide-react'
import { fetchComponentsByIds, type Component } from '../catalog'
import { Field, QueryState } from '../ui'

type Format = 'a4' | '58x40' | '40x30'
const FORMATS: { id: Format; label: string; hint: string }[] = [
  { id: 'a4', label: 'A4, 3×8 (70×37 мм)', hint: 'самоклейка на листе A4, 24 шт' },
  { id: '58x40', label: 'Термопринтер 58×40 мм', hint: 'по одной этикетке на страницу' },
  { id: '40x30', label: 'Термопринтер 40×30 мм', hint: 'по одной этикетке на страницу' },
]
const SIZE: Record<Format, [number, number]> = { a4: [70, 37], '58x40': [58, 40], '40x30': [40, 30] }

/** QR ведёт на карточку компонента: навёл телефон на ящик — открылся остаток и место. */
export const componentUrl = (id: string) => `${location.origin}${import.meta.env.BASE_URL}components/${id}`

function Qr({ text, size }: { text: string; size: number }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M')
    q.addData(text)
    q.make()
    return q.createSvgTag({ margin: 0, scalable: true })
  }, [text])
  return <div className="shrink-0 [&>svg]:h-full [&>svg]:w-full" style={{ width: `${size}mm`, height: `${size}mm` }} dangerouslySetInnerHTML={{ __html: svg }} />
}

function Label({ c, format, show }: { c: Component; format: Format; show: { sku: boolean; loc: boolean; mfr: boolean } }) {
  const [w, h] = SIZE[format]
  const qr = h - 6
  return (
    <div className="label flex items-center gap-[2mm] overflow-hidden bg-white p-[2.5mm] text-black"
      style={{ width: `${w}mm`, height: `${h}mm`, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}>
      <Qr text={componentUrl(c.id)} size={qr} />
      <div className="flex min-w-0 flex-1 flex-col justify-between self-stretch">
        <div className="line-clamp-3 font-semibold leading-tight" style={{ fontSize: format === '40x30' ? '2.6mm' : '3.1mm' }}>{c.name}</div>
        <div className="space-y-[0.5mm] leading-tight" style={{ fontSize: format === '40x30' ? '2.2mm' : '2.5mm' }}>
          {show.sku && c.sku && <div className="truncate font-mono">{c.sku}</div>}
          {show.mfr && c.manufacturer && <div className="truncate">{c.manufacturer}</div>}
          {show.loc && c.location && <div className="truncate font-semibold">{c.location}</div>}
        </div>
      </div>
    </div>
  )
}

/** Печать этикеток с QR для выбранных компонентов: /components/labels?ids=a,b,c */
export default function ComponentLabels() {
  const [params] = useSearchParams()
  const ids = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean), [params])
  const q = useQuery({ queryKey: ['components', 'byIds', ids], queryFn: () => fetchComponentsByIds(ids) })
  const [format, setFormat] = useState<Format>(() => { try { return (localStorage.getItem('fl-label-format') as Format) || 'a4' } catch { return 'a4' } })
  const [copies, setCopies] = useState('1')
  const [show, setShow] = useState({ sku: true, loc: true, mfr: false })
  useEffect(() => { try { localStorage.setItem('fl-label-format', format) } catch { /* не запомним — не страшно */ } }, [format])

  const n = Math.min(50, Math.max(1, Math.floor(Number(copies)) || 1))
  const labels = (q.data ?? []).flatMap(c => Array.from({ length: n }, (_, i) => ({ c, key: `${c.id}-${i}` })))
  const [w, h] = SIZE[format]
  const pageCss = format === 'a4'
    ? '@page { size: A4; margin: 0; }'
    : `@page { size: ${w}mm ${h}mm; margin: 0; } .label-cell + .label-cell { break-before: page; }`

  return (
    <div className="mx-auto max-w-6xl">
      <style>{`@media print { ${pageCss} }`}</style>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link to="/components" className="dash-muted inline-flex items-center gap-1 text-sm hover:text-[var(--d-text)]"><ArrowLeft className="h-4 w-4" aria-hidden /> Компоненты</Link>
        <button className="dash-btn" disabled={!labels.length} onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden /> Печать</button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[280px_1fr] print:block">
        <aside className="dash-card space-y-3 p-4 print:hidden" aria-label="Настройки этикеток">
          <h2 className="dash-label">Этикетки: {q.data?.length ?? 0} поз. × {n} = {labels.length} шт</h2>
          <Field label="Формат">
            <select className="dash-input" value={format} onChange={e => setFormat(e.target.value as Format)}>
              {FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </Field>
          <p className="dash-muted -mt-1 text-xs">{FORMATS.find(f => f.id === format)!.hint}</p>
          <Field label="Копий каждой"><input className="dash-input" inputMode="numeric" value={copies} onChange={e => setCopies(e.target.value)} /></Field>
          <fieldset className="space-y-1 text-sm">
            <legend className="dash-label mb-1">На этикетке</legend>
            {([['sku', 'Артикул'], ['mfr', 'Производитель'], ['loc', 'Место хранения']] as const).map(([k, l]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" className="accent-[var(--d-accent)]" checked={show[k]} onChange={e => setShow(s => ({ ...s, [k]: e.target.checked }))} /> {l}
              </label>
            ))}
          </fieldset>
          <p className="dash-muted text-xs">QR открывает карточку компонента — войти нужно под своей учёткой. В окне печати: масштаб 100%, без полей и колонтитулов.</p>
        </aside>

        <div className="min-w-0 overflow-x-auto print:overflow-visible">
        <QueryState loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty={labels.length === 0} emptyText="Компоненты не выбраны" emptyHint="Отметьте галочками в списке компонентов и нажмите «Этикетки»">
          <div className={`labels-sheet mx-auto rounded-md bg-neutral-200 p-4 print:rounded-none print:bg-white print:p-0 ${format === 'a4' ? 'grid w-fit grid-cols-[repeat(3,70mm)] auto-rows-[37mm]' : 'flex flex-wrap gap-3 print:block'}`}>
            {labels.map(l => (
              <div key={l.key} className={format === 'a4' ? 'outline outline-1 outline-dashed outline-neutral-300 print:outline-none' : 'label-cell shadow print:shadow-none'}>
                <Label c={l.c} format={format} show={show} />
              </div>
            ))}
          </div>
        </QueryState>
        </div>
      </div>
    </div>
  )
}

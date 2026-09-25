import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Inbox, Loader2, X } from 'lucide-react'
import type { Member } from './types'
import { initials } from './meta'

export function Avatar({ member, size = 28 }: { member?: Pick<Member, 'name' | 'avatar_url'> | null; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.38) }
  if (!member) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--d-line)] text-[var(--d-muted)]"
        style={style} title="Не назначено" aria-label="Не назначено"
      >?</span>
    )
  }
  return member.avatar_url ? (
    <img src={member.avatar_url} alt={member.name} className="shrink-0 rounded-full object-cover" style={style} />
  ) : (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--d-raised)] font-semibold text-[var(--d-accent)] ring-1 ring-[var(--d-line)]"
      style={style} title={member.name} aria-label={member.name}
    >{initials(member.name)}</span>
  )
}

export function Spinner({ label = 'Загрузка' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 dash-muted text-sm">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}…
    </span>
  )
}

/** Единая обвязка состояний экрана: загрузка, ошибка с повтором, пустота. */
export function QueryState({
  loading, error, empty, emptyText, emptyHint, onRetry, children,
}: {
  loading: boolean
  error: unknown
  empty?: boolean
  emptyText?: string
  emptyHint?: ReactNode
  onRetry: () => void
  children: ReactNode
}) {
  if (loading) return <div className="py-10 text-center"><Spinner /></div>
  if (error) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
        <AlertTriangle className="h-6 w-6 text-[var(--d-tint)]" aria-hidden />
        <p className="text-sm">Не удалось загрузить данные.</p>
        <p className="dash-muted max-w-md text-xs">{error instanceof Error ? error.message : String(error)}</p>
        <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={onRetry}>Повторить</button>
      </div>
    )
  }
  if (empty) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <Inbox className="h-6 w-6 dash-muted" aria-hidden />
        <p className="text-sm">{emptyText ?? 'Пока пусто'}</p>
        {emptyHint && <p className="dash-muted text-xs">{emptyHint}</p>}
      </div>
    )
  }
  return <>{children}</>
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {sub && <p className="dash-muted mt-1 text-sm">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** Поле даты: клик в любое место открывает календарь, а не выбирает сегмент дд/мм/гггг. */
export function DateInput({ value, onChange, disabled, min, label, title }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; min?: string; label?: string; title?: string
}) {
  return (
    <input
      className="dash-input" type="date" value={value} min={min} disabled={disabled} aria-label={label} title={title}
      onChange={e => onChange(e.target.value)}
      onClick={e => { try { e.currentTarget.showPicker() } catch { /* браузер без showPicker */ } }}
    />
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="dash-label mb-1.5 block">{label}</span>
      {children}
      {hint && <span className="dash-muted mt-1 block text-xs">{hint}</span>}
    </label>
  )
}

/**
 * Модалка на нативном <dialog>: фокус-ловушка и возврат фокуса даёт браузер.
 * Если в окне уже что-то введено, закрытие «случайным» способом (клик по фону,
 * крестик, Esc) спрашивает подтверждение — иначе промах мышью стирает форму.
 * Явные кнопки «Отмена» и «Готово» в самой форме закрывают без вопросов.
 */
export function Modal({ open, onClose, title, children, guard = true }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode
  /** false — не спрашивать (например, после успешного сохранения, когда терять нечего) */
  guard?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const dirty = useRef(false)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) { dirty.current = false; d.showModal() }
    if (!open && d.open) d.close()
  }, [open])

  const tryClose = () => {
    if (guard && dirty.current && !confirm('Закрыть окно? Введённые данные не сохранятся.')) return
    onClose()
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onInput={() => { dirty.current = true }}
      // Esc: если есть введённое — не даём окну закрыться само, сначала спрашиваем
      onCancel={e => { if (guard && dirty.current) { e.preventDefault(); tryClose() } }}
      onClick={e => { if (e.target === ref.current) tryClose() }}
      aria-labelledby="modal-title"
      className="m-auto max-h-[calc(100dvh-24px)] w-[min(520px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-[var(--d-line)] bg-[var(--d-surface)] p-0 text-[var(--d-text)] backdrop:bg-black/60"
    >
      {open && (
        <div className="p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id="modal-title" className="text-lg font-semibold">{title}</h2>
            <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={tryClose} aria-label="Закрыть">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  )
}

// ── уведомления-тосты ───────────────────────────────────────────────────────

interface Toast { id: number; text: string; tone: 'ok' | 'error' }
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random()
    setItems(x => [...x, { id, text, tone }])
    setTimeout(() => setItems(x => x.filter(t => t.id !== id)), tone === 'error' ? 7000 : 3500)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-20 left-1/2 z-[100] flex w-[min(420px,calc(100vw-24px))] -translate-x-1/2 flex-col gap-2 md:bottom-6" aria-live="polite">
        {items.map(t => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
            className={`rounded-xl border px-4 py-3 text-sm shadow-lg ${t.tone === 'error'
              ? 'border-[var(--d-danger)] bg-[var(--d-danger-bg)]' : 'border-[var(--d-line)] bg-[var(--d-raised)]'}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Что-то пошло не так')

/** Знак и надпись First Logic. */
export function Brand({ sub, compact }: { sub?: string; compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden>
        <rect x="0.5" y="0.5" width="31" height="31" rx="6" fill="#0a0d11" stroke="var(--d-line-strong)" />
        <path d="M9 23V9h10M9 16h7" fill="none" stroke="var(--d-accent)" strokeWidth="2.6" strokeLinecap="square" />
        <path d="M21 9v14h4" fill="none" stroke="var(--d-text)" strokeWidth="2.6" strokeLinecap="square" />
      </svg>
      <div className={`min-w-0 leading-tight ${compact ? 'sr-only' : ''}`}>
        <div className="whitespace-nowrap text-[15px] font-semibold tracking-tight">First Logic</div>
        {sub && <div className="dash-label !text-[10px]">{sub}</div>}
      </div>
    </div>
  )
}

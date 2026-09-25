import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, Unlink } from 'lucide-react'
import { supabase } from './supabase'
import { useWorkspace } from './auth'
import { fmtMoney, parseAmount } from './money'
import { Field, Spinner, errMsg, useToast } from './ui'

export const BOT_USERNAME = 'first_logic_bot'

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

const NOTIFY_KINDS: { id: string; label: string; hint: string }[] = [
  { id: 'task', label: 'Задачи', hint: 'назначили на вас, сменился статус, приоритет или срок' },
  { id: 'comment', label: 'Комментарии', hint: 'в ваших задачах и упоминания' },
  { id: 'overdue', label: 'Просрочки', hint: 'ваша задача просрочена' },
  { id: 'low_stock', label: 'Низкий остаток', hint: 'компонент дошёл до минимума' },
  { id: 'price', label: 'Цены', hint: 'изменилась цена компонента' },
  { id: 'product_status', label: 'Статус изделия', hint: 'например, разработка → производство' },
  { id: 'expense', label: 'Каждый расход', hint: 'кто-то записал трату' },
  { id: 'budget', label: 'Превышение бюджета', hint: 'расходы месяца больше бюджета' },
]

/** Привязка Telegram, виды уведомлений, месячный бюджет. */
export function TelegramSettings() {
  const { me, workspace } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [code, setCode] = useState<string | null>(null)

  const link = useQuery({
    queryKey: ['tg-link', me.id],
    queryFn: async () => (check(await supabase.from('fl_tg_links').select('*').eq('member_id', me.id).maybeSingle()) as
      { tg_username: string | null; linked_at: string } | null),
    refetchInterval: code ? 3000 : false, // ждём, пока человек нажмёт Start в боте
  })
  const prefs = useQuery({
    queryKey: ['notify-prefs', me.id],
    queryFn: async () => check(await supabase.from('fl_notify_prefs').select('kind, enabled').eq('member_id', me.id)) as { kind: string; enabled: boolean }[],
  })

  const makeCode = useMutation({
    mutationFn: async () => check(await supabase.rpc('fl_tg_create_link_code')) as string,
    onSuccess: c => setCode(c),
    onError: e => toast(errMsg(e), 'error'),
  })
  const unlink = useMutation({
    mutationFn: async () => { check(await supabase.rpc('fl_tg_unlink')) },
    onSuccess: () => { setCode(null); qc.invalidateQueries({ queryKey: ['tg-link'] }); toast('Telegram отвязан') },
    onError: e => toast(errMsg(e), 'error'),
  })
  const toggle = useMutation({
    mutationFn: async ({ kind, enabled }: { kind: string; enabled: boolean }) => {
      check(await supabase.from('fl_notify_prefs').upsert({ member_id: me.id, kind, enabled }, { onConflict: 'member_id,kind' }))
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-prefs'] }),
    onError: e => toast(errMsg(e), 'error'),
  })

  const linked = link.data
  useEffect(() => { if (linked) setCode(null) }, [linked])
  const enabled = (kind: string) => prefs.data?.find(p => p.kind === kind)?.enabled ?? true
  const deepLink = code ? `https://t.me/${BOT_USERNAME}?start=${code}` : null

  return (
    <section className="dash-card mb-4 p-5" aria-label="Telegram">
      <h2 className="dash-label mb-3">Telegram</h2>
      {link.isLoading ? <Spinner /> : linked ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            <span className="dash-led mr-2 text-[var(--d-ok)]" aria-hidden />
            Привязан{linked.tg_username && <> как <b>@{linked.tg_username}</b></>}. Пишите <a className="text-[var(--d-accent)] underline" href={`https://t.me/${BOT_USERNAME}`} target="_blank" rel="noopener noreferrer">@{BOT_USERNAME}</a> — задачи, расходы и склад попадут сюда.
          </p>
          <button className="dash-btn dash-btn-ghost dash-btn-sm" disabled={unlink.isPending} onClick={() => confirm('Отвязать Telegram? Бот перестанет принимать от вас сообщения и присылать уведомления.') && unlink.mutate()}>
            <Unlink className="h-4 w-4" aria-hidden /> Отвязать
          </button>
        </div>
      ) : deepLink ? (
        <div className="space-y-2 text-sm">
          <p>Откройте ссылку и нажмите <b>Start</b> — бот привяжет этот аккаунт. Ссылка действует 15 минут.</p>
          <a className="dash-btn" href={deepLink} target="_blank" rel="noopener noreferrer"><Send className="h-4 w-4" aria-hidden /> Открыть @{BOT_USERNAME}</a>
          <p className="dash-muted text-xs">Или отправьте боту: <code className="dash-mono">/start {code}</code> — жду подтверждения…</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="dash-muted text-sm">Привяжите Telegram, чтобы создавать задачи и расходы сообщениями и получать уведомления.</p>
          <button className="dash-btn" disabled={makeCode.isPending} onClick={() => makeCode.mutate()}><Send className="h-4 w-4" aria-hidden /> Привязать</button>
        </div>
      )}

      <h3 className="dash-label mb-2 mt-5">Уведомления в Telegram</h3>
      <ul className="grid gap-x-6 sm:grid-cols-2">
        {NOTIFY_KINDS.map(k => (
          <li key={k.id} className="dash-row py-2">
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" className="mt-0.5 accent-[var(--d-accent)]" checked={enabled(k.id)} disabled={!prefs.data}
                onChange={e => toggle.mutate({ kind: k.id, enabled: e.target.checked })} />
              <span>{k.label}<span className="dash-muted block text-xs">{k.hint}</span></span>
            </label>
          </li>
        ))}
      </ul>
      {!linked && <p className="dash-muted mt-2 text-xs">Настройки сохранятся и начнут работать после привязки.</p>}

      <Budget workspaceId={workspace.id} />
    </section>
  )
}

function Budget({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({
    queryKey: ['budget', workspaceId],
    queryFn: async () => (check(await supabase.from('ws_workspaces').select('monthly_budget').eq('id', workspaceId).single()) as { monthly_budget: number | null }).monthly_budget,
  })
  const [v, setV] = useState<string | null>(null)
  const value = v ?? (q.data ? String(q.data) : '')
  const save = useMutation({
    mutationFn: async (b: number | null) => { check(await supabase.from('ws_workspaces').update({ monthly_budget: b }).eq('id', workspaceId).select('id')) },
    onSuccess: (_d, b) => { setV(null); qc.invalidateQueries({ queryKey: ['budget'] }); toast(b ? `Бюджет: ${fmtMoney(b, 'RUB')} в месяц` : 'Бюджет снят') },
    onError: e => toast(errMsg(e), 'error'),
  })
  const commit = () => {
    if (v === null) return
    const n = v.trim() ? parseAmount(v) : null
    if (n !== null && (!Number.isFinite(n) || n <= 0)) { toast('Бюджет — положительное число', 'error'); return }
    save.mutate(n)
  }
  return (
    <div className="mt-5 max-w-xs">
      <Field label="Месячный бюджет расходов, ₽" hint="Общий для команды. Когда расходы месяца его превысят — придёт уведомление">
        <input className="dash-input" inputMode="decimal" placeholder="не задан" value={value}
          onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      </Field>
    </div>
  )
}

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateMyProfile } from './api'
import { useWorkspace } from './auth'
import { timeAgo } from './meta'
import type { Member, PresenceMode } from './types'
import { Field, errMsg, useToast } from './ui'

const MODES: { id: PresenceMode; label: string; hint: string }[] = [
  { id: 'always', label: 'Всегда', hint: 'Команда видит, когда вы заходили' },
  { id: 'schedule', label: 'В рабочее время', hint: 'Вне окна время захода не записывается' },
  { id: 'never', label: 'Никогда', hint: 'Вместо времени — «скрыта»' },
]

const hhmm = (t: string | undefined, d: string) => (t ?? d).slice(0, 5)

/** Что показывать другим в поле «активность». */
export function presenceLabel(m: Member) {
  if (m.presence_mode === 'never') return 'скрыта'
  return timeAgo(m.last_seen)
}

export function PresenceSettings() {
  const { me } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [mode, setMode] = useState<PresenceMode>(me.presence_mode ?? 'always')
  const [from, setFrom] = useState(hhmm(me.presence_from, '09:00'))
  const [to, setTo] = useState(hhmm(me.presence_to, '19:00'))
  const dirty = mode !== (me.presence_mode ?? 'always') || from !== hhmm(me.presence_from, '09:00') || to !== hhmm(me.presence_to, '19:00')

  const save = useMutation({
    mutationFn: () => {
      if (mode === 'schedule' && from === to) throw new Error('Начало и конец окна совпадают')
      return updateMyProfile(me.id, {
        presence_mode: mode, presence_from: from, presence_to: to,
        presence_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow',
      })
    },
    onSuccess: () => { toast('Сохранено'); void qc.invalidateQueries({ queryKey: ['members'] }); void qc.invalidateQueries({ queryKey: ['memberships'] }) },
    onError: e => toast(errMsg(e), 'error'),
  })

  return (
    <section className="dash-card mb-4 p-5" aria-label="Видимость активности">
      <h2 className="dash-label mb-3">Видимость активности</h2>
      <div role="radiogroup" aria-label="Кому видно, когда вы заходили" className="grid gap-2 sm:grid-cols-3">
        {MODES.map(m => (
          <label key={m.id} className={`cursor-pointer rounded-lg border p-3 text-sm ${mode === m.id ? 'border-[var(--d-accent)] bg-[var(--d-raised)]' : 'border-[var(--d-line)]'}`}>
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name="presence" className="accent-[var(--d-accent)]" checked={mode === m.id} onChange={() => setMode(m.id)} /> {m.label}
            </span>
            <span className="dash-muted mt-1 block text-xs">{m.hint}</span>
          </label>
        ))}
      </div>
      {mode === 'schedule' && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:w-80">
          <Field label="С"><input type="time" className="dash-input" value={from} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="До"><input type="time" className="dash-input" value={to} onChange={e => setTo(e.target.value)} /></Field>
          <p className="dash-muted col-span-2 text-xs">По времени этого устройства. Можно через полночь: 22:00 – 06:00.</p>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <button className="dash-btn" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Сохраняем…' : 'Сохранить'}</button>
      </div>
    </section>
  )
}

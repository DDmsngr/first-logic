import { useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { supabase } from './supabase'
import { Field, Modal, useToast } from './ui'

export default function ChangePassword({ label }: { label?: string }) {
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toast = useToast()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) { setError(error.message); return }
    setPw('')
    setOpen(false)
    toast('Пароль изменён')
  }

  return (
    <>
      <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => setOpen(true)} aria-label="Сменить пароль" title="Сменить пароль">
        <KeyRound className="h-4 w-4" aria-hidden />{label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Смена пароля">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Новый пароль" hint="Не короче 8 символов">
            <input className="dash-input" type="password" minLength={8} required autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} />
          </Field>
          {error && <p role="alert" className="text-sm text-[var(--d-tint)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="dash-btn dash-btn-ghost" onClick={() => setOpen(false)}>Отмена</button>
            <button className="dash-btn" disabled={busy}>Сохранить</button>
          </div>
        </form>
      </Modal>
    </>
  )
}

import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useAuth } from '../auth'
import { Brand, Field, Spinner } from '../ui'

export default function Login() {
  const { session, ready } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const from = (loc.state as { from?: string } | null)?.from ?? '/'
  if (ready && session) return <Navigate to={from} replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (error) setError(error.message === 'Invalid login credentials' ? 'Неверный email или пароль' : error.message)
    else nav(from, { replace: true })
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <form onSubmit={submit} className="dash-card w-full max-w-sm space-y-4 p-6" aria-labelledby="login-title">
        <div>
          <Brand sub="Engineering · Production" />
          <h1 id="login-title" className="mt-5 text-xl font-semibold">Вход в систему</h1>
          <p className="dash-muted mt-1 text-sm">Рабочее пространство команды. Вход только для участников.</p>
        </div>
        <Field label="Email">
          <input className="dash-input" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
        </Field>
        <Field label="Пароль">
          <input className="dash-input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
        </Field>
        {error && <p role="alert" className="text-sm text-[var(--d-tint)]">{error}</p>}
        <button className="dash-btn w-full" disabled={busy}>{busy ? <Spinner label="Входим" /> : 'Войти'}</button>
        <p className="dash-muted text-xs">Нет аккаунта? Попросите владельца прислать приглашение.</p>
      </form>
    </main>
  )
}

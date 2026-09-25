import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { acceptInvitation, invitationPreview } from '../api'
import { useAuth } from '../auth'
import { Field, QueryState, Spinner, errMsg, Brand } from '../ui'

/** Токен живёт во фрагменте URL (#...): в отличие от пути и query он не уходит на сервер. */
export default function Invite() {
  const token = useLocation().hash.replace(/^#/, '')
  const nav = useNavigate()
  const { session } = useAuth()
  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [accepting, setAccepting] = useState(false)

  const preview = useQuery({
    queryKey: ['invite', token], queryFn: () => invitationPreview(token), enabled: !!token, retry: false,
  })
  const inv = preview.data

  // вошедший пользователь сразу принимает приглашение
  useEffect(() => {
    if (!session || !inv || accepting) return
    setAccepting(true)
    acceptInvitation(token)
      .then(() => nav('/', { replace: true }))
      .catch(e => { setError(errMsg(e)); setAccepting(false) })
  }, [session, inv]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!inv) return
    setBusy(true)
    setError('')
    if (mode === 'signup') {
      // письма подтверждения на сервере не работают: аккаунт создаёт функция БД
      // по токену приглашения (токен и подтверждает владение почтой)
      const reg = await supabase.rpc('ws_register_via_invitation', { p_token: token, p_password: password })
      if (reg.error) {
        setBusy(false)
        setError(reg.error.message)
        if (reg.error.message.includes('уже есть')) setMode('login')
        return
      }
    }
    const res = await supabase.auth.signInWithPassword({ email: inv.email, password })
    setBusy(false)
    if (res.error) setError(res.error.message === 'Invalid login credentials' ? 'Неверный пароль' : res.error.message)
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="dash-card w-full max-w-sm p-6">
        <Brand />
        <h1 className="mt-5 text-xl font-semibold">Приглашение в команду</h1>
        {!token ? (
          <p role="alert" className="mt-4 text-sm">В ссылке нет токена приглашения. Запросите новую.</p>
        ) : (
          <QueryState loading={preview.isLoading} error={preview.error} onRetry={() => preview.refetch()}
            empty={!inv} emptyText="Приглашение недействительно или просрочено" emptyHint="Попросите владельца выпустить новое.">
            {inv && (
              <div className="mt-3 space-y-4">
                <p className="text-sm">
                  {inv.name}, вас приглашают в <b>{inv.workspace_name}</b> как {inv.role}.
                </p>
                {inv.message && <p className="dash-muted rounded-lg bg-[var(--d-bg)] p-3 text-sm">«{inv.message}»</p>}
                {accepting ? <Spinner label="Принимаем приглашение" /> : session ? (
                  <p role="alert" className="text-sm text-[var(--d-tint)]">{error || 'Вы уже вошли под другим аккаунтом.'}</p>
                ) : (
                  <form onSubmit={submit} className="space-y-3">
                    <Field label="Email (из приглашения)">
                      <input className="dash-input opacity-70" value={inv.email} readOnly aria-readonly />
                    </Field>
                    <Field label={mode === 'signup' ? 'Придумайте пароль' : 'Пароль'} hint={mode === 'signup' ? 'Не короче 8 символов' : undefined}>
                      <input className="dash-input" type="password" minLength={mode === 'signup' ? 8 : undefined} required value={password}
                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} onChange={e => setPassword(e.target.value)} />
                    </Field>
                    {error && <p role="alert" className="text-sm text-[var(--d-tint)]">{error}</p>}
                    <button className="dash-btn w-full" disabled={busy}>
                      {mode === 'signup' ? 'Создать аккаунт и войти' : 'Войти и принять'}
                    </button>
                    <button type="button" className="dash-muted w-full text-center text-xs underline"
                      onClick={() => { setMode(m => (m === 'signup' ? 'login' : 'signup')); setError('') }}>
                      {mode === 'signup' ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Создать'}
                    </button>
                  </form>
                )}
              </div>
            )}
          </QueryState>
        )}
      </div>
    </main>
  )
}

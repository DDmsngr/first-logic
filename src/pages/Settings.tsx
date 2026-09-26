import { InstallApp } from '../installApp'
import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Camera, Trash2 } from 'lucide-react'
import { removeAvatarFile, updateMyProfile, uploadAvatar } from '../api'
import { useWorkspace } from '../auth'
import { ROLE_LABEL } from '../meta'
import ChangePassword from '../ChangePassword'
import { TelegramSettings } from '../telegram'
import { PresenceSettings } from '../presence'
import { Avatar, Field, PageHeader, Spinner, errMsg, useToast } from '../ui'

export default function Settings() {
  const { me, userId } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(me.name)
  const [position, setPosition] = useState(me.position ?? '')
  const [phone, setPhone] = useState(me.phone ?? '')

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['members'] })
    void qc.invalidateQueries({ queryKey: ['memberships'] })
  }

  const save = useMutation({
    mutationFn: () => updateMyProfile(me.id, {
      name: name.trim(), position: position.trim() || null, phone: phone.trim() || null,
    }),
    onSuccess: () => { toast('Профиль сохранён'); refresh() },
    onError: e => toast(errMsg(e), 'error'),
  })

  const photo = useMutation({
    mutationFn: async (file: File) => {
      const url = await uploadAvatar(userId, file, me.avatar_url)
      await updateMyProfile(me.id, { avatar_url: url })
    },
    onSuccess: () => { toast('Фото обновлено'); refresh() },
    onError: e => toast(errMsg(e), 'error'),
  })

  const dropPhoto = useMutation({
    mutationFn: async () => {
      await updateMyProfile(me.id, { avatar_url: null })
      await removeAvatarFile(me.avatar_url)
    },
    onSuccess: () => { toast('Фото удалено'); refresh() },
    onError: e => toast(errMsg(e), 'error'),
  })

  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate() }
  const busy = photo.isPending || dropPhoto.isPending

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Настройки" sub="Профиль, видимость, Telegram и уведомления, безопасность" />

      <section className="dash-card mb-4 p-5" aria-label="Профиль">
        <h2 className="dash-label mb-4">Профиль</h2>
        <div className="mb-5 flex items-center gap-4">
          <Avatar member={me} size={72} />
          <div className="flex flex-wrap gap-2">
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1}
              aria-label="Файл фото"
              onChange={e => { const f = e.target.files?.[0]; if (f) photo.mutate(f); e.target.value = '' }} />
            <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" disabled={busy}
              onClick={() => fileInput.current?.click()}>
              {photo.isPending
                ? <Spinner label="Загружаем" />
                : <><Camera className="h-4 w-4" aria-hidden /> {me.avatar_url ? 'Заменить фото' : 'Загрузить фото'}</>}
            </button>
            {me.avatar_url && (
              <button type="button" className="dash-btn dash-btn-ghost dash-btn-sm" disabled={busy} onClick={() => dropPhoto.mutate()}>
                <Trash2 className="h-4 w-4" aria-hidden /> Удалить
              </button>
            )}
            <p className="dash-muted w-full text-xs">JPG, PNG или WebP. Фото обрежется до квадрата.</p>
          </div>
        </div>

        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Имя"><input className="dash-input" required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></Field>
          <Field label="Должность"><input className="dash-input" maxLength={80} placeholder="Например, инженер-конструктор" value={position} onChange={e => setPosition(e.target.value)} /></Field>
          <Field label="Телефон"><input className="dash-input" type="tel" maxLength={40} autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} /></Field>
          <Field label="Email" hint="Меняется только через владельца"><input className="dash-input" readOnly value={me.email} /></Field>
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <span className="dash-chip">Роль: {ROLE_LABEL[me.role]}</span>
            <button className="dash-btn" disabled={save.isPending || !name.trim()}>{save.isPending ? 'Сохраняем…' : 'Сохранить'}</button>
          </div>
        </form>
      </section>

      <InstallApp />

      <PresenceSettings />

      <TelegramSettings />

      <section className="dash-card p-5" aria-label="Безопасность">
        <h2 className="dash-label mb-3">Безопасность</h2>
        <ChangePassword label="Сменить пароль" />
      </section>
    </div>
  )
}

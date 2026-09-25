import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Bell, Box, Boxes, Coins, Cpu, FolderOpen, LayoutDashboard, ListChecks, LogOut, Menu, MessageSquare, Search, Settings, Truck, Users,
  type LucideIcon,
} from 'lucide-react'
import { signOut, useWorkspace } from './auth'
import { fetchNotifications, fetchUnread } from './api'
import { Avatar, Brand, Modal } from './ui'
import ChangePassword from './ChangePassword'

interface NavItem { to: string; label: string; icon: LucideIcon; end?: boolean; mobile?: boolean }

// mobile: пункт попадает в нижнюю панель телефона, остальные — в «Ещё»
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Работа',
    items: [
      { to: '/', label: 'Обзор', icon: LayoutDashboard, end: true, mobile: true },
      { to: '/tasks', label: 'Задачи', icon: ListChecks, mobile: true },
      { to: '/messages', label: 'Сообщения', icon: MessageSquare },
    ],
  },
  {
    group: 'Производство',
    items: [
      { to: '/products', label: 'Изделия', icon: Box, mobile: true },
      { to: '/assemblies', label: 'Узлы', icon: Boxes },
      { to: '/components', label: 'Компоненты', icon: Cpu },
      { to: '/suppliers', label: 'Поставщики', icon: Truck },
    ],
  },
  {
    group: 'Справочники',
    items: [
      { to: '/currency', label: 'Курсы валют', icon: Coins },
      { to: '/files', label: 'Файлы', icon: FolderOpen },
      { to: '/team', label: 'Команда', icon: Users },
    ],
  },
  {
    group: 'Система',
    items: [
      { to: '/settings', label: 'Настройки', icon: Settings },
    ],
  },
]

const ALL = NAV.flatMap(g => g.items)

export default function Layout({ children }: { children: ReactNode }) {
  const { workspace, me } = useWorkspace()
  const wsId = workspace.id
  const nav = useNavigate()
  const loc = useLocation()
  const [more, setMore] = useState(false)

  const unread = useQuery({ queryKey: ['unread', wsId], queryFn: () => fetchUnread(wsId), refetchInterval: 60_000 })
  const notes = useQuery({ queryKey: ['notifications', wsId], queryFn: () => fetchNotifications(wsId), refetchInterval: 60_000 })
  const msgBadge = Object.values(unread.data ?? {}).reduce((a, b) => a + b, 0)
  const noteBadge = (notes.data ?? []).filter(n => !n.read_at).length

  const [q, setQ] = useState('')
  useEffect(() => { if (!loc.pathname.endsWith('/search')) setQ('') }, [loc.pathname])
  useEffect(() => { setMore(false) }, [loc.pathname])
  // дебаунс: поиск уходит в БД только после паузы в наборе
  useEffect(() => {
    if (q.trim().length < 2) return
    const t = setTimeout(() => nav(`/search?q=${encodeURIComponent(q.trim())}`, { replace: loc.pathname.endsWith('/search') }), 350)
    return () => clearTimeout(t)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps

  const badge = (to: string) => (to === '/messages' && msgBadge > 0 ? msgBadge : 0)
  const moreActive = ALL.some(n => !n.mobile && loc.pathname.startsWith(n.to))

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-[var(--d-line)] bg-[var(--d-surface)]/85 backdrop-blur md:flex">
        <div className="border-b border-[var(--d-line)] px-4 py-4">
          <Brand sub="Engineering" />
        </div>
        <nav aria-label="Основная навигация" className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
          {NAV.map(g => (
            <div key={g.group}>
              <div className="dash-label mb-1.5 px-2 !text-[10px]">{g.group}</div>
              <div className="flex flex-col gap-0.5">
                {g.items.map(n => (
                  <NavLink key={n.to} to={n.to} end={n.end}
                    className={({ isActive }) => `group relative flex min-h-9 items-center gap-3 rounded-md px-2.5 text-sm transition-colors ${isActive
                      ? 'bg-[var(--d-raised)] text-[var(--d-text)] before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-[var(--d-accent)] before:shadow-[0_0_8px_var(--d-accent)]'
                      : 'text-[var(--d-muted)] hover:bg-[var(--d-raised)] hover:text-[var(--d-text)]'}`}>
                    {({ isActive }) => (
                      <>
                        <n.icon className={`h-4 w-4 ${isActive ? 'text-[var(--d-accent)]' : ''}`} aria-hidden />
                        <span className="flex-1">{n.label}</span>
                        {badge(n.to) > 0 && (
                          <span className="dash-mono rounded bg-[var(--d-accent)] px-1.5 text-[11px] font-semibold text-[var(--d-on-accent)]"
                            aria-label={`${badge(n.to)} непрочитанных`}>{badge(n.to)}</span>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t border-[var(--d-line)] p-3">
          <NavLink to="/settings" className="flex min-w-0 flex-1 items-center gap-2 rounded-md hover:opacity-80" title="Настройки профиля">
            <Avatar member={me} size={30} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{me.name}</div>
              <div className="dash-muted truncate text-xs">{me.position || me.email}</div>
            </div>
          </NavLink>
          <ChangePassword />
          <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => void signOut()} aria-label="Выйти" title="Выйти">
            <LogOut className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="dash-safe-top sticky top-0 z-30 flex items-center gap-3 border-b border-[var(--d-line)] bg-[var(--d-bg)]/85 px-4 py-2.5 backdrop-blur md:px-6">
          <div className="relative md:hidden"><Brand compact /></div>
          <form role="search" className="relative ml-auto w-full max-w-md" onSubmit={e => { e.preventDefault(); if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`) }}>
            <Search className="dash-muted pointer-events-none absolute left-3 top-3 h-4 w-4" aria-hidden />
            <input className="dash-input pl-9" type="search" value={q} onChange={e => setQ(e.target.value)}
              placeholder="Поиск" aria-label="Глобальный поиск" />
          </form>
          <NavLink to="/notifications" className="dash-btn dash-btn-ghost relative !px-3"
            aria-label={noteBadge ? `Уведомления, непрочитанных: ${noteBadge}` : 'Уведомления'}>
            <Bell className="h-4 w-4" aria-hidden />
            {noteBadge > 0 && (
              <span className="dash-mono absolute -right-1 -top-1 rounded bg-[var(--d-accent)] px-1 text-[10px] font-semibold text-[var(--d-on-accent)]">{noteBadge}</span>
            )}
          </NavLink>
        </header>

        <main className="mx-auto w-full min-w-0 max-w-[1600px] flex-1 px-4 pb-28 pt-5 md:px-6 md:pb-10">{children}</main>

        <nav aria-label="Навигация" className="dash-safe-bottom fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--d-line)] bg-[var(--d-surface)]/95 backdrop-blur md:hidden">
          {ALL.filter(n => n.mobile).map(n => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => `relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${isActive ? 'text-[var(--d-accent)]' : 'text-[var(--d-muted)]'}`}>
              <n.icon className="h-5 w-5" aria-hidden />
              {n.label}
              {badge(n.to) > 0 && <span className="dash-mono absolute right-[22%] top-1.5 rounded bg-[var(--d-accent)] px-1 text-[10px] font-semibold text-[var(--d-on-accent)]">{badge(n.to)}</span>}
            </NavLink>
          ))}
          <button type="button" onClick={() => setMore(true)}
            className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${moreActive ? 'text-[var(--d-accent)]' : 'text-[var(--d-muted)]'}`}>
            <Menu className="h-5 w-5" aria-hidden />
            Ещё
          </button>
        </nav>

        <Modal open={more} onClose={() => setMore(false)} title="Разделы">
          <div className="space-y-4">
            {NAV.map(g => (
              <div key={g.group}>
                <div className="dash-label mb-1.5">{g.group}</div>
                <div className="grid grid-cols-2 gap-2">
                  {g.items.map(n => (
                    <NavLink key={n.to} to={n.to} end={n.end}
                      className={({ isActive }) => `flex min-h-11 items-center gap-2.5 rounded-md border px-3 text-sm ${isActive
                        ? 'border-[var(--d-accent)] text-[var(--d-accent)]' : 'border-[var(--d-line)] text-[var(--d-text)]'}`}>
                      <n.icon className="h-4 w-4" aria-hidden />{n.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2 border-t border-[var(--d-line)] pt-3">
              <Avatar member={me} size={30} />
              <div className="min-w-0 flex-1 truncate text-sm">{me.name}</div>
              <button className="dash-btn dash-btn-ghost dash-btn-sm" onClick={() => void signOut()}>
                <LogOut className="h-4 w-4" aria-hidden /> Выйти
              </button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  )
}

import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, WorkspaceProvider, useAuth } from './auth'
import { isConfigured } from './supabase'
import { Spinner, ToastProvider } from './ui'
import Layout from './Layout'
import Login from './pages/Login'
import Invite from './pages/Invite'
import Home from './pages/Home'
import Tasks from './pages/Tasks'
import TaskDetail from './pages/TaskDetail'
import Team from './pages/Team'
import MemberProfile from './pages/MemberProfile'
import Files from './pages/Files'
import FilePage from './pages/FilePage'
import Messages from './pages/Messages'
import SearchPage from './pages/SearchPage'
import Notifications from './pages/Notifications'

// Realtime мгновенно инвалидирует кеш, а опрос раз в 20 с — страховка на случай
// оборванного websocket (корпоративный прокси, спящая вкладка). Вкладка в фоне не опрашивается.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: true, refetchInterval: 20_000 },
  },
})

function Protected() {
  const { session, ready } = useAuth()
  const loc = useLocation()
  if (!ready) return <div className="grid min-h-dvh place-items-center"><Spinner /></div>
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />
  return (
    <WorkspaceProvider session={session}>
      <Layout><Outlet /></Layout>
    </WorkspaceProvider>
  )
}

export default function DashboardApp() {
  if (!isConfigured) {
    return (
      <div className="dash grid place-items-center px-6 text-center">
        <div className="max-w-md">
          <h1 className="text-xl font-semibold">Dashboard не подключён к бэкенду</h1>
          <p className="dash-muted mt-2 text-sm">
            В сборке нет VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY. Задайте их как переменные
            репозитория (Settings → Variables) и пересоберите.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="dash">
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AuthProvider>
            <Routes>
              <Route path="login" element={<Login />} />
              <Route path="invite" element={<Invite />} />
              <Route element={<Protected />}>
                <Route index element={<Home />} />
                <Route path="tasks" element={<Tasks />} />
                <Route path="tasks/:id" element={<TaskDetail />} />
                <Route path="team" element={<Team />} />
                <Route path="team/:userId" element={<MemberProfile />} />
                <Route path="files" element={<Files />} />
                <Route path="files/:id" element={<FilePage />} />
                <Route path="messages" element={<Messages />} />
                <Route path="messages/:convId" element={<Messages />} />
                <Route path="search" element={<SearchPage />} />
                <Route path="notifications" element={<Notifications />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </div>
  )
}

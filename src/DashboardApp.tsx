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
import Settings from './pages/Settings'
import Components from './pages/Components'
import ComponentDetail from './pages/ComponentDetail'
import Suppliers from './pages/Suppliers'
import SupplierDetail from './pages/SupplierDetail'
import CurrencyPage from './pages/Currency'
import Products from './pages/Products'
import ProductDetail from './pages/ProductDetail'
import Assemblies from './pages/Assemblies'
import AssemblyDetail from './pages/AssemblyDetail'
import Finance from './pages/Finance'
import Orders from './pages/Orders'
import OrderDetail from './pages/OrderDetail'
import ProductOffer from './pages/ProductOffer'

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
                <Route path="settings" element={<Settings />} />
                <Route path="components" element={<Components />} />
                <Route path="components/:id" element={<ComponentDetail />} />
                <Route path="suppliers" element={<Suppliers />} />
                <Route path="suppliers/:id" element={<SupplierDetail />} />
                <Route path="currency" element={<CurrencyPage />} />
                <Route path="products" element={<Products />} />
                <Route path="products/:id" element={<ProductDetail />} />
                <Route path="products/:id/offer" element={<ProductOffer />} />
                <Route path="assemblies" element={<Assemblies />} />
                <Route path="assemblies/:id" element={<AssemblyDetail />} />
                <Route path="finance" element={<Finance />} />
                <Route path="orders" element={<Orders />} />
                <Route path="orders/:id" element={<OrderDetail />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </div>
  )
}

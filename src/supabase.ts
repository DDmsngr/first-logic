import { createClient } from '@supabase/supabase-js'

// trim: лишний перевод строки или BOM в переменной ломают заголовки fetch
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim()
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim()

export const isConfigured = Boolean(url && anonKey)

// anon-ключ публичен по дизайну Supabase: всю защиту дают RLS-политики в БД.
export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'fl-auth' },
})

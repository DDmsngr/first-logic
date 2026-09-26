// HTTP-вход для сайта (не для Telegram): разбор документа в задачи. Только для вошедших участников.
import { Db } from './db'
import { buildExtractRequest, normalizeExtracted, parseExtractBody } from './extract'
import { LimitError, generateJson } from './parse'

interface ApiEnv { SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string; DASHBOARD_URL: string; ALLOWED_ORIGINS?: string; GEMINI: string; GEMINI_MODEL: string }

function corsFor(req: Request, env: ApiEnv) {
  const allowed = [new URL(env.DASHBOARD_URL).origin, ...(env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)]
  const origin = req.headers.get('Origin') ?? ''
  return {
    ok: allowed.includes(origin),
    headers: {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    } as Record<string, string>,
  }
}

const json = (data: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } })

/** Возвращает Response для /api/*, иначе null (не наш путь). */
export async function handleApi(req: Request, env: ApiEnv): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== '/api/extract-tasks') return null
  const cors = corsFor(req, env)
  if (req.method === 'OPTIONS') return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers })
  if (req.method !== 'POST') return json({ error: 'Только POST' }, 405, cors.headers)
  if (!cors.ok) return json({ error: 'Запрос с чужого адреса' }, 403, cors.headers)

  // кто спрашивает: токен входа проверяет сам Supabase, потом смотрим, что это активный участник
  const auth = req.headers.get('Authorization') ?? ''
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!jwt) return json({ error: 'Нужно войти' }, 401, cors.headers)
  const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${jwt}` } })
  if (!who.ok) return json({ error: 'Сессия истекла, войдите заново' }, 401, cors.headers)
  const user = await who.json() as { id?: string }
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
  if (!user.id || !(await db.isActiveMember(user.id))) return json({ error: 'Нет доступа' }, 403, cors.headers)

  const body = await req.json().catch(() => null)
  const parsed = parseExtractBody(body)
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status, cors.headers)

  try {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
    const raw = await generateJson(buildExtractRequest(parsed.input, today, parsed.people), env.GEMINI, env.GEMINI_MODEL)
    return json({ tasks: normalizeExtracted(raw) }, 200, cors.headers)
  } catch (e) {
    console.error('extract failed:', (e as Error).message)
    return e instanceof LimitError
      ? json({ error: 'Сервис ИИ сейчас перегружен (лимит запросов). Повторите через минуту.' }, 429, cors.headers)
      : json({ error: 'Не удалось разобрать документ. Попробуйте ещё раз или пришлите файл в другом формате.' }, 502, cors.headers)
  }
}

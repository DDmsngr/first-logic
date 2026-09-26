// Задачи из документа: запрос к боту (Cloudflare Worker), который зовёт Gemini. Ключ ИИ в браузер не попадает.
import { supabase } from './supabase'
import { FORMAT_ID } from './taskJson'
import type { DocContent } from './docText'

/** Адрес бота: меняется переменной сборки, если бот переедет. */
const BOT_URL = ((import.meta.env.VITE_BOT_URL as string | undefined)?.trim() || 'https://first-logic-bot.ddmsngr.workers.dev').replace(/\/$/, '')

export interface ExtractedTask { title: string; description?: string; priority?: string; due?: string; assignee?: string; labels?: string[] }

export async function extractTasks(doc: DocContent, people: string[]): Promise<ExtractedTask[]> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Сессия истекла, войдите заново.')
  let res: Response
  try {
    res = await fetch(`${BOT_URL}/api/extract-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(doc.kind === 'pdf' ? { kind: 'pdf', pdf_base64: doc.base64, people } : { kind: 'text', text: doc.text, people }),
    })
  } catch {
    throw new Error('Нет связи с сервисом разбора. Проверьте интернет и повторите.')
  }
  const body = await res.json().catch(() => null) as { tasks?: ExtractedTask[]; error?: string } | null
  if (!res.ok) throw new Error(body?.error ?? `Сервис разбора ответил ошибкой (${res.status}).`)
  return body?.tasks ?? []
}

/** Черновик задач в формате импорта: дальше его показывает обычный предпросмотр. */
export const asImportJson = (tasks: ExtractedTask[]) => JSON.stringify({ format: FORMAT_ID, version: 1, tasks }, null, 2)

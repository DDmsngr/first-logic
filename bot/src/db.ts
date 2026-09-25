// Доступ к базе dashboard: те же таблицы, service_role, только через функции fl_bot_*.
import type { Intent } from './intents'

export interface Ctx {
  member: { id: string; user_id: string; name: string; workspace_id: string }
  products: { id: string; name: string; version: string | null; sku: string | null }[]
  components: { id: string; name: string; sku: string | null; unit: string; stock: number; min_stock: number; price: number; currency: string }[]
  suppliers: { id: string; name: string }[]
  expense_categories: { id: string; name: string }[]
  component_categories: { id: string; name: string }[]
  members: { user_id: string; name: string }[]
  my_tasks: { num: number; title: string; status: string; due_date: string | null }[]
}

export class Db {
  constructor(private url: string, private key: string) {}

  private async req(path: string, init: RequestInit = {}) {
    const r = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json',
        Prefer: 'return=representation', ...(init.headers ?? {}),
      },
    })
    const text = await r.text()
    const body = text ? JSON.parse(text) : null
    if (!r.ok) throw new Error(body?.message ?? `supabase ${r.status}`)
    return body
  }

  rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}) {
    return this.req(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }) as Promise<T>
  }

  context(tgUserId: number) { return this.rpc<Ctx | null>('fl_bot_context', { p_tg_user: tgUserId }) }
  redeem(code: string, tgUser: number, chat: number, username: string | null) {
    return this.rpc<{ name: string }>('fl_bot_redeem', { p_code: code, p_tg_user: tgUser, p_chat: chat, p_username: username })
  }
  apply(memberId: string, intent: Intent) { return this.rpc<{ id: string; num?: number; link: string }>('fl_bot_apply', { p_member: memberId, p_intent: intent }) }

  async savePending(p: { member_id: string; chat_id: number; source_text: string; intent: Intent }) {
    const rows = await this.req('fl_tg_pending', { method: 'POST', body: JSON.stringify(p) }) as { id: string }[]
    return rows[0].id
  }
  setPendingMessage(id: string, messageId: number) {
    return this.req(`fl_tg_pending?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ message_id: messageId }) })
  }
  /** Чья команда ждёт подтверждения (null — нет такой или уже неактуальна). */
  async pendingOwner(id: string) {
    const rows = await this.req(`fl_tg_pending?id=eq.${id}&select=member_id&expires_at=gt.${new Date().toISOString()}`) as { member_id: string }[]
    return rows[0]?.member_id ?? null
  }
  async takePending(id: string, memberId: string) {
    // забираем и удаляем одним запросом: двойное нажатие не выполнит команду дважды
    const rows = await this.req(`fl_tg_pending?id=eq.${id}&member_id=eq.${memberId}&expires_at=gt.${new Date().toISOString()}`,
      { method: 'DELETE' }) as { intent: Intent; source_text: string }[]
    return rows[0] ?? null
  }

  outboxBatch() { return this.rpc<{ id: number; chat_id: number; text: string; link: string | null }[]>('fl_bot_outbox_batch', { p_limit: 30 }) }
  outboxDone(id: number, error: string | null) { return this.rpc('fl_bot_outbox_done', { p_id: id, p_error: error }) }
  syncOverdue() { return this.rpc('fl_bot_sync_overdue') }
}

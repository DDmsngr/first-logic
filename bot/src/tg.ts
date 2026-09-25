// Минимальная обёртка над Telegram Bot API.

export interface TgUser { id: number; username?: string; first_name?: string }
export interface TgMessage {
  message_id: number
  chat: { id: number; type: string }
  from?: TgUser
  text?: string
  caption?: string
}
export interface TgCallback { id: string; from: TgUser; data?: string; message?: TgMessage }
export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage; callback_query?: TgCallback }

export type Button = { text: string; callback_data?: string; url?: string }

export class Tg {
  constructor(private token: string) {}

  private async call(method: string, body: unknown) {
    const r = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => ({})) as { ok?: boolean; result?: unknown; description?: string }
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? r.status}`)
    return j.result
  }

  send(chatId: number, text: string, opts: { buttons?: Button[][]; replyTo?: number } = {}) {
    return this.call('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
      ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
    }) as Promise<TgMessage>
  }

  edit(chatId: number, messageId: number, text: string, buttons?: Button[][]) {
    return this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons ?? [] },
    })
  }

  answer(callbackId: string, text?: string) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) })
  }

  typing(chatId: number) {
    return this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined)
  }

  setWebhook(url: string, secret: string) {
    return this.call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true })
  }

  setCommands() {
    return this.call('setMyCommands', {
      commands: [
        { command: 'help', description: 'Что я умею' },
        { command: 'tasks', description: 'Мои открытые задачи' },
        { command: 'low', description: 'Что пора заказать' },
        { command: 'me', description: 'Чей это аккаунт' },
      ],
    })
  }
}

/** Экранирование для parse_mode HTML. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

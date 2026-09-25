// @first_logic_bot — Telegram-вход в dashboard First Logic.
// Сообщение → разбор (Gemini) → команда → база dashboard → ответ с подтверждением.
// Обратно: очередь fl_outbox (её наполняют триггеры базы) → уведомления раз в минуту.

import { Db, type Ctx } from './db'
import { ASK_TITLE, DONE_TITLE, describe, needsConfirm, normalize, type Intent } from './intents'
import { parseMessage } from './parse'
import { Tg, esc, type TgCallback, type TgMessage, type TgUpdate } from './tg'

export interface Env {
  BOT_TOKEN: string
  GEMINI: string
  GEMINI_MODEL: string
  SUPABASE_URL: string
  SUPABASE_SERVICE_KEY: string
  WEBHOOK_SECRET: string
  DASHBOARD_URL: string
}

const HELP = `Я — вход в dashboard First Logic. Пишите обычным текстом:

• <i>Купить 10 разъёмов SMA для 100W</i> — задача
• <i>Завтра проверить температуру выходного каскада</i> — задача со сроком
• <i>#12 готово</i> — статус задачи
• <i>Потратил 8500 на корпуса для 200W</i> — расход (спрошу подтверждение)
• <i>Добавь 5 шт BLF188XR по 3200</i> — приход на склад (спрошу подтверждение)
• <i>Сколько осталось SMA?</i> — вопрос по данным

Команды: /tasks — мои задачи, /low — что пора заказать, /me — чей аккаунт.`

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/setup') {
      // одноразовая настройка вебхука: ключ — тот же WEBHOOK_SECRET
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 })
      const tg = new Tg(env.BOT_TOKEN)
      await tg.setWebhook(`${url.origin}/webhook`, env.WEBHOOK_SECRET)
      await tg.setCommands()
      return new Response('webhook set')
    }
    if (req.method === 'GET') return new Response('first-logic bot alive')
    if (req.method !== 'POST' || url.pathname !== '/webhook') return new Response('not found', { status: 404 })
    if ((req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 })

    const update = await req.json().catch(() => null) as TgUpdate | null
    if (update) ctx.waitUntil(handle(update, env).catch(e => console.error('update failed:', (e as Error).message)))
    return new Response('ok') // Telegram не ждёт разбора — отвечаем сразу
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(flushOutbox(env))
    if (new Date().getUTCMinutes() === 0) ctx.waitUntil(new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY).syncOverdue().then(() => undefined))
  },
}

async function handle(u: TgUpdate, env: Env) {
  if (u.callback_query) return onCallback(u.callback_query, env)
  if (u.message) return onMessage(u.message, env)
}

const link = (env: Env, path: string, label = 'Открыть в dashboard') => `<a href="${env.DASHBOARD_URL}${path}">${label}</a>`

async function onMessage(msg: TgMessage, env: Env) {
  const tg = new Tg(env.BOT_TOKEN)
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
  const chat = msg.chat.id
  const text = (msg.text ?? msg.caption ?? '').trim()
  if (!msg.from || !text) return
  if (msg.chat.type !== 'private') return // работаем только в личке: там понятно, кто пишет

  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1]
    if (code) {
      try {
        const r = await db.redeem(code, msg.from.id, chat, msg.from.username ?? null)
        return tg.send(chat, `Готово, ${esc(r.name)}: Telegram привязан к dashboard.\n\n${HELP}`)
      } catch (e) {
        return tg.send(chat, `Не получилось привязать: ${esc((e as Error).message)}.\nВозьмите новый код в dashboard → Настройки → Telegram.`)
      }
    }
  }

  const c = await db.context(msg.from.id)
  if (!c) {
    return tg.send(chat, `Этот Telegram ещё не привязан к dashboard.\n\nОткройте ${link(env, '/settings', 'Настройки')} → «Telegram» → «Привязать» и перейдите по ссылке.`)
  }

  if (text === '/help' || text.startsWith('/start')) return tg.send(chat, HELP)
  if (text === '/me') return tg.send(chat, `Вы — <b>${esc(c.member.name)}</b>. ${link(env, '/settings', 'Настройки уведомлений')}`)
  if (text === '/tasks') return tg.send(chat, tasksText(c, env))
  if (text === '/low') return tg.send(chat, lowText(c, env))

  await tg.typing(chat)
  let raw: Record<string, unknown>
  try {
    raw = await parseMessage(text, c, today(), env.GEMINI, env.GEMINI_MODEL)
  } catch (e) {
    console.error('parse failed:', (e as Error).message)
    return tg.send(chat, 'Не смог разобрать сообщение — сервис разбора не ответил. Попробуйте ещё раз через минуту.', { replyTo: msg.message_id })
  }
  const { intent, missing } = normalize(raw, c)

  if (intent.intent === 'query') return tg.send(chat, esc(intent.answer ?? 'Не нашёл ответа в данных dashboard.'), { replyTo: msg.message_id })
  if (intent.intent === 'unknown' || missing.length) {
    const ask = intent.clarification ?? (missing.length ? `Не хватает: ${missing.join(', ')}.` : 'Не понял, что сделать.')
    return tg.send(chat, `🤔 ${esc(ask)}\n\nНапишите подробнее или /help.`, { replyTo: msg.message_id })
  }

  if (needsConfirm(intent)) {
    const id = await db.savePending({ member_id: c.member.id, chat_id: chat, source_text: text, intent })
    const sent = await tg.send(chat, [`<b>${ASK_TITLE[intent.intent]}</b>`, ...describe(intent, c, esc)].join('\n'), {
      replyTo: msg.message_id,
      buttons: [[{ text: '✅ Создать', callback_data: `ok:${id}` }, { text: '✖ Отмена', callback_data: `no:${id}` }]],
    })
    await db.setPendingMessage(id, sent.message_id)
    return
  }

  return run(tg, db, env, c, intent, chat, msg.message_id)
}

async function run(tg: Tg, db: Db, env: Env, c: Ctx, intent: Intent, chat: number, replyTo?: number, editId?: number) {
  let text: string
  try {
    const r = await db.apply(c.member.id, intent)
    const lines = describe(intent, c, esc)
    if (intent.intent === 'create_task' && r.num) lines[0] = `#${r.num} ${lines[0].replace(/^Задача /, '')}`
    text = [`<b>${DONE_TITLE[intent.intent]}</b>`, ...lines, '', link(env, r.link)].join('\n')
  } catch (e) {
    text = `❌ Не получилось: ${esc((e as Error).message)}`
  }
  return editId ? tg.edit(chat, editId, text) : tg.send(chat, text, { replyTo })
}

async function onCallback(cb: TgCallback, env: Env) {
  const tg = new Tg(env.BOT_TOKEN)
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
  const [action, id] = (cb.data ?? '').split(':')
  const msg = cb.message
  if (!msg || !id) return tg.answer(cb.id)
  const c = await db.context(cb.from.id)
  if (!c) return tg.answer(cb.id, 'Telegram не привязан к dashboard')
  const pending = await db.takePending(id, c.member.id)
  if (!pending) {
    await tg.answer(cb.id, 'Уже неактуально')
    return tg.edit(msg.chat.id, msg.message_id, `${msg.text ?? ''}\n\n<i>неактуально: уже выполнено, отменено или прошли сутки</i>`)
  }
  await tg.answer(cb.id)
  if (action === 'no') return tg.edit(msg.chat.id, msg.message_id, `✖ Отменено: ${esc(pending.source_text)}`)
  return run(tg, db, env, c, pending.intent, msg.chat.id, undefined, msg.message_id)
}

function tasksText(c: Ctx, env: Env) {
  if (!c.my_tasks.length) return `На вас открытых задач нет. ${link(env, '/tasks?assignee=none', 'Свободные задачи')}`
  const d = today()
  const rows = c.my_tasks.slice(0, 15).map(t =>
    `#${t.num} ${esc(t.title)}${t.due_date ? ` — ${t.due_date < d ? '⚠️ просрочено ' : ''}${new Date(t.due_date + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : ''}`)
  return [`<b>Ваши задачи · ${c.my_tasks.length}</b>`, ...rows, '', link(env, '/tasks')].join('\n')
}

function lowText(c: Ctx, env: Env) {
  const low = c.components.filter(x => x.min_stock > 0 && x.stock <= x.min_stock)
  if (!low.length) return 'Все остатки выше минимума 👍'
  return [`<b>Пора заказать · ${low.length}</b>`, ...low.slice(0, 20).map(x => `• ${esc(x.name)} — ${x.stock} ${esc(x.unit)} (мин. ${x.min_stock})`), '',
    link(env, '/components?reorder=1')].join('\n')
}

async function flushOutbox(env: Env) {
  const tg = new Tg(env.BOT_TOKEN)
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
  const batch = await db.outboxBatch()
  for (const n of batch) {
    try {
      await tg.send(n.chat_id, `${esc(n.text)}${n.link ? `\n${link(env, n.link, 'Открыть')}` : ''}`)
      await db.outboxDone(n.id, null)
    } catch (e) {
      await db.outboxDone(n.id, (e as Error).message.slice(0, 300))
    }
  }
}

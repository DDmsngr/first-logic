// @first_logic_bot — Telegram-вход в dashboard First Logic.
// Сообщение → разбор (Gemini) → команда → база dashboard → ответ с подтверждением.
// Обратно: очередь fl_outbox (её наполняют триггеры базы) → уведомления раз в минуту.

import { Db, type Ctx, type Digest } from './db'
import { ASK_TITLE, DONE_TITLE, canAttach, describe, fillFromText, needsConfirm, normalize, type Intent, type TgFile } from './intents'
import { handleApi } from './api'
import { LimitError, parseMessage, type Audio } from './parse'
import { isGroupChat, routeText } from './route'
import { Tg, esc, type TgCallback, type TgMessage, type TgUpdate } from './tg'

export interface Env {
  BOT_TOKEN: string
  GEMINI: string
  GEMINI_MODEL: string
  SUPABASE_URL: string
  SUPABASE_SERVICE_KEY: string
  WEBHOOK_SECRET: string
  DASHBOARD_URL: string
  BOT_USERNAME: string
  ALLOWED_ORIGINS?: string
}

const HELP = `Я — вход в dashboard First Logic. Пишите обычным текстом:

• <i>Купить 10 разъёмов SMA для 100W</i> — задача
• <i>Завтра проверить температуру выходного каскада</i> — задача со сроком
• <i>#12 готово</i> — статус задачи
• <i>Потратил 8500 на корпуса для 200W</i> — расход (спрошу подтверждение)
• <i>Добавь 5 шт BLF188XR по 3200</i> — приход на склад (спрошу подтверждение)
• <i>Собрал 3 сотки</i> — списать детали по составу (спрошу подтверждение)
• <i>Сколько осталось SMA?</i> — вопрос по данным
• <i>Какие задачи свободные?</i> — или /free
• <i>Возьму #5</i> / <i>Отказываюсь от #5</i> — взять свободную задачу или вернуть
• <i>В #5 напиши: проверил, всё в норме</i> — комментарий к задаче
• Голосовое сообщение — то же самое, что текст (в группе — ответом на моё сообщение)
• Файл или фото с подписью <i>«Задача: …»</i> — прикреплю к новой задаче

Команды: /tasks — мои задачи, /free — свободные, /low — что пора заказать, /digest — сводка на сегодня, /me — чей аккаунт.

В группе начинайте сообщение с @first_logic_bot или отвечайте на мои сообщения — иначе я молчу.`

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const api = await handleApi(req, env)
    if (api) return api
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
    const now = new Date()
    if (now.getUTCMinutes() === 0) ctx.waitUntil(new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY).syncOverdue().then(() => undefined))
    // 06:00 UTC = 09:00 МСК; по выходным не беспокоим
    const day = now.getUTCDay()
    if (now.getUTCHours() === 6 && now.getUTCMinutes() === 0 && day !== 0 && day !== 6) ctx.waitUntil(sendDigests(env))
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
  const inGroup = isGroupChat(msg.chat.type)
  const file = fileOf(msg)
  const attachTo = file ? attachTarget(msg, env) : null
  const botId = Number(env.BOT_TOKEN.split(':')[0])
  const routed = routeText(msg.chat.type, msg.text ?? msg.caption ?? '', {
    username: env.BOT_USERNAME, botId, replyToId: msg.reply_to_message?.from?.id,
  })
  // голос: в личке всегда; в группе бот слышит только ответы на свои сообщения (упомянуть его в голосовом нельзя)
  const voice = msg.voice && (!inGroup || msg.reply_to_message?.from?.id === botId) ? msg.voice : null
  console.log(`msg chat=${msg.chat.type} from=${msg.from?.id ?? '-'} len=${(msg.text ?? msg.caption ?? '').length} file=${file ? `${file.mime ?? '?'} ${file.size}` : '-'} voice=${voice ? voice.duration + 's' : '-'} accepted=${routed !== null}`)
  if (!msg.from) return
  // файл ответом на сообщение бота с ссылкой на задачу/изделие — прикрепляем без разбора
  if (file && attachTo) return attachReply(tg, db, env, msg, file, attachTo)
  // файл без подписи: в личке подскажем, в группе (где нужно упоминание) молчим
  if (file && !routed && !inGroup) {
    return tg.send(chat, 'Файл получил, но не понял, что с ним делать. Отправьте его ещё раз с подписью, например: <i>Задача: разобрать таблицу по покрытию</i>.')
  }
  if (!routed && !voice) return
  const text = routed ?? ''
  // в группе отвечаем на конкретное сообщение, чтобы было видно, кому
  const reply = inGroup ? { replyTo: msg.message_id } : {}

  if (text.startsWith('/start')) {
    if (inGroup) return tg.send(chat, `Привязка — только в личных сообщениях: откройте @${env.BOT_USERNAME} и нажмите Start.`, reply)
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
    return tg.send(chat, `Этот Telegram ещё не привязан к dashboard.\n\nОткройте ${link(env, '/settings', 'Настройки')} → «Telegram» → «Привязать» и перейдите по ссылке.`, reply)
  }

  if (text === '/help' || text.startsWith('/start')) return tg.send(chat, HELP, reply)
  if (text === '/me') return tg.send(chat, `Вы — <b>${esc(c.member.name)}</b>. ${link(env, '/settings', 'Настройки уведомлений')}`, reply)
  if (text === '/tasks') return tg.send(chat, tasksText(c, env), reply)
  if (text === '/free') return tg.send(chat, freeText(c, env), reply)
  if (text === '/low') return tg.send(chat, lowText(c, env), reply)
  if (text === '/digest') {
    const d = await db.digest(c.member.id)
    return tg.send(chat, d ? digestText(d, env) : 'Сводка недоступна', reply)
  }

  await tg.typing(chat)
  let raw: Record<string, unknown>
  let audio: Audio | undefined
  if (voice) {
    if (voice.duration > 180 || (voice.file_size ?? 0) > 5 * 1024 * 1024) {
      return tg.send(chat, 'Голосовое слишком длинное: до 3 минут. Разбейте на части или напишите текстом.', { replyTo: msg.message_id })
    }
    try {
      audio = { mime: voice.mime_type ?? 'audio/ogg', base64: toBase64(await tg.download(voice.file_id)) }
    } catch (e) {
      console.error('voice download failed:', (e as Error).message)
      return tg.send(chat, 'Не смог скачать голосовое. Попробуйте ещё раз или напишите текстом.', { replyTo: msg.message_id })
    }
  }
  try {
    raw = await parseMessage(text, c, today(), env.GEMINI, env.GEMINI_MODEL, audio)
  } catch (e) {
    console.error('parse failed:', (e as Error).message)
    const text = e instanceof LimitError
      ? 'Сервис разбора сейчас перегружен (лимит запросов Gemini). Повторите через минуту.'
      : 'Не смог разобрать сообщение — сервис разбора не ответил. Попробуйте ещё раз через минуту.'
    return tg.send(chat, text, { replyTo: msg.message_id })
  }
  // что услышали: показываем в ответе, чтобы ошибку распознавания было видно сразу
  const said = voice ? (typeof raw.transcript === 'string' ? raw.transcript.trim() : '') : text
  if (voice && !said) return tg.send(chat, 'Не разобрал речь. Повторите ещё раз или напишите текстом.', { replyTo: msg.message_id })
  const echo = voice ? `🎤 <i>${esc(said)}</i>\n\n` : ''
  const norm = normalize(raw, c)
  const intent = fillFromText(norm.intent, said, c, today())
  const missing = norm.missing
  if (file && canAttach(intent) && !missing.length) {
    if (file.size > TG_LIMIT) return tg.send(chat, 'Файл больше 20 МБ — Telegram не отдаёт такие боту. Загрузите его в задачу на сайте (до 25 МБ).', { replyTo: msg.message_id })
    intent.tg_file = file
  }

  if (intent.intent === 'query') return tg.send(chat, echo + esc(intent.answer ?? 'Не нашёл ответа в данных dashboard.'), { replyTo: msg.message_id })
  if (intent.intent === 'unknown' || missing.length) {
    const ask = intent.clarification ?? (missing.length ? `Не хватает: ${missing.join(', ')}.` : 'Не понял, что сделать.')
    return tg.send(chat, `${echo}🤔 ${esc(ask)}\n\nНапишите подробнее или /help.`, { replyTo: msg.message_id })
  }

  if (file && !intent.tg_file) {
    return tg.send(chat, '📎 Файл можно прикрепить, только когда я создаю задачу или заметку к изделию. Напишите в подписи, что это за задача.', { replyTo: msg.message_id })
  }

  if (needsConfirm(intent)) {
    const id = await db.savePending({ member_id: c.member.id, chat_id: chat, source_text: said, intent })
    const sent = await tg.send(chat, [`${echo}<b>${ASK_TITLE[intent.intent]}</b>`, ...describe(intent, c, esc)].join('\n'), {
      replyTo: msg.message_id,
      buttons: [[{ text: '✅ Создать', callback_data: `ok:${id}` }, { text: '✖ Отмена', callback_data: `no:${id}` }]],
    })
    await db.setPendingMessage(id, sent.message_id)
    return
  }

  return run(tg, db, env, c, intent, chat, msg.message_id, undefined, echo)
}

async function run(tg: Tg, db: Db, env: Env, c: Ctx, intent: Intent, chat: number, replyTo?: number, editId?: number, prefix = '') {
  let text: string
  try {
    const r = await db.apply(c.member.id, intent)
    const lines = describe(intent, c, esc)
    if (intent.intent === 'create_task' && r.num) lines[0] = `#${r.num} ${lines[0].replace(/^Задача /, '')}`
    // задача уже создана — сбой файла не должен выглядеть как сбой задачи
    const f = intent.tg_file
    if (f) {
      const i = lines.findIndex(l => l.startsWith('📎'))
      try {
        await db.attach(c, intent.intent === 'add_note' ? { product: r.id } : { task: r.id }, f, await tg.download(f.file_id))
      } catch (e) {
        const why = (e as Error).message
        lines[i < 0 ? lines.length : i] = `⚠️ Файл ${esc(f.name)} не прикрепился: ${esc(/too big/i.test(why) ? 'больше 20 МБ' : why)}. Добавьте его вручную на сайте.`
      }
    }
    if (intent.intent === 'create_task' && !f) lines.push('', '📎 Нужен файл — ответьте на это сообщение файлом.')
    text = [`${prefix}<b>${DONE_TITLE[intent.intent]}</b>`, ...lines, '', link(env, r.link)].join('\n')
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
  // в группе кнопки видят все, нажать может только автор команды
  const owner = await db.pendingOwner(id)
  if (owner && owner !== c.member.id) return tg.answer(cb.id, 'Это команда другого участника')
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

/** Задача или изделие, на чьё сообщение бота ответили файлом: берём id из ссылки в этом сообщении. */
function attachTarget(msg: TgMessage, env: Env): { kind: 'task' | 'product'; id: string } | null {
  const r = msg.reply_to_message
  if (!r || r.from?.id !== Number(env.BOT_TOKEN.split(':')[0])) return null
  const re = new RegExp(`${env.DASHBOARD_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(tasks|products)/([0-9a-f-]{36})`)
  for (const e of r.entities ?? []) {
    const m = e.url?.match(re)
    if (m) return { kind: m[1] === 'tasks' ? 'task' : 'product', id: m[2] }
  }
  return null
}

async function attachReply(tg: Tg, db: Db, env: Env, msg: TgMessage, file: TgFile, t: { kind: 'task' | 'product'; id: string }) {
  const chat = msg.chat.id
  const reply = { replyTo: msg.message_id }
  const c = await db.context(msg.from!.id)
  if (!c) return tg.send(chat, 'Этот Telegram ещё не привязан к dashboard.', reply)
  if (file.size > TG_LIMIT) return tg.send(chat, 'Файл больше 20 МБ — Telegram не отдаёт такие боту. Загрузите его на сайте (до 25 МБ).', reply)
  try {
    await db.attach(c, t.kind === 'task' ? { task: t.id } : { product: t.id }, file, await tg.download(file.file_id))
    return tg.send(chat, `📎 Прикрепил ${esc(file.name)}\n${link(env, `/${t.kind === 'task' ? 'tasks' : 'products'}/${t.id}`)}`, reply)
  } catch (e) {
    const why = (e as Error).message
    return tg.send(chat, `❌ Файл не прикрепился: ${esc(/too big/i.test(why) ? 'больше 20 МБ' : why)}`, reply)
  }
}

function freeText(c: Ctx, env: Env) {
  const list = c.free_tasks ?? []
  if (!list.length) return `Свободных задач нет 👍 ${link(env, '/tasks', 'Все задачи')}`
  const d = today()
  const rows = list.slice(0, 20).map(t =>
    `#${t.num} ${esc(t.title)}${t.due_date ? ` — ${t.due_date < d ? '⚠️ просрочено ' : ''}${new Date(t.due_date + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : ''}`)
  return [`<b>Свободные задачи · ${list.length}</b>`, ...rows, '', 'Взять задачу — кнопкой на сайте.', link(env, '/tasks?assignee=none')].join('\n')
}

const TG_LIMIT = 20 * 1024 * 1024

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Документ или самое крупное фото из сообщения. */
function fileOf(msg: TgMessage): TgFile | null {
  if (msg.document) {
    const d = msg.document
    return { file_id: d.file_id, name: d.file_name ?? 'файл', mime: d.mime_type ?? null, size: d.file_size ?? 0 }
  }
  const p = msg.photo?.slice().sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]
  return p ? { file_id: p.file_id, name: `фото-${msg.message_id}.jpg`, mime: 'image/jpeg', size: p.file_size ?? 0 } : null
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

function digestText(d: Digest, env: Env) {
  const date = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  const out = [`<b>Доброе утро, ${esc(d.name.split(' ')[0])}!</b>`]
  if (d.overdue.length) out.push('', `⚠️ <b>Просрочено · ${d.overdue.length}</b>`, ...d.overdue.slice(0, 8).map(t => `#${t.num} ${esc(t.title)} — с ${date(t.due_date)}`))
  if (d.due_today.length) out.push('', `📌 <b>Сегодня срок · ${d.due_today.length}</b>`, ...d.due_today.slice(0, 8).map(t => `#${t.num} ${esc(t.title)}`))
  out.push('', `В работе у вас: ${d.in_progress}${d.free ? ` · свободных задач: ${d.free}` : ''}`)
  if (d.orders_due.length) out.push('', `🚚 <b>Ждём поставки · ${d.orders_due.length}</b>`, ...d.orders_due.map(o => `Заказ №${o.num}${o.supplier ? ` (${esc(o.supplier)})` : ''} — к ${date(o.expected_on)}`))
  if (d.low.length) out.push('', `📦 <b>Пора заказать · ${d.low.length}</b>`, ...d.low.slice(0, 10).map(x => `• ${esc(x.name)} — ${x.stock} ${esc(x.unit)} (мин. ${x.min})`))
  out.push('', link(env, '/', 'Открыть dashboard'))
  return out.join('\n')
}

async function sendDigests(env: Env) {
  const tg = new Tg(env.BOT_TOKEN)
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
  for (const t of await db.digestTargets()) {
    try {
      const d = await db.digest(t.member_id)
      // пустую сводку не шлём: нечего сказать — не отвлекаем
      if (d && (d.overdue.length || d.due_today.length || d.low.length || d.orders_due.length)) await tg.send(t.chat_id, digestText(d, env))
    } catch (e) {
      console.error('digest failed:', (e as Error).message)
    }
  }
}

// Разбор сообщения через Gemini: строгий JSON по схеме, справочники — в контексте.
import type { Ctx } from './db'
import { INTENTS } from './intents'

const S = (description: string) => ({ type: 'STRING', nullable: true, description })
const N = (description: string) => ({ type: 'NUMBER', nullable: true, description })

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: [...INTENTS] },
    confidence: { type: 'NUMBER', description: 'уверенность 0..1' },
    title: S('название задачи — повелительно, как в сообщении'),
    description: S('описание задачи или расхода'),
    priority: { type: 'STRING', nullable: true, enum: ['low', 'normal', 'high', 'critical'] },
    due_date: S('срок YYYY-MM-DD'),
    product_id: S('id изделия из списка products'),
    assignee_user_id: S('user_id исполнителя из members, если назван'),
    task_num: N('номер задачи #N для update_task'),
    status: { type: 'STRING', nullable: true, enum: ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done'] },
    amount: N('сумма расхода'),
    currency: { type: 'STRING', nullable: true, enum: ['RUB', 'USD', 'CNY', 'EUR'] },
    category_id: S('id категории из expense_categories (для расхода) или component_categories (для нового компонента)'),
    supplier_id: S('id поставщика из suppliers'),
    component_id: S('id компонента из components'),
    spent_on: S('дата расхода YYYY-MM-DD, если названа'),
    qty: N('количество'),
    price: N('цена за единицу'),
    name: S('название нового компонента, изделия или узла'),
    sku: S('артикул'),
    unit: S('единица измерения'),
    version: S('версия изделия'),
    text: S('текст заметки'),
    answer: S('для query: короткий ответ по данным контекста'),
    clarification: S('для unknown или сомнений: что уточнить у пользователя'),
  },
  required: ['intent', 'confidence'],
}

const RULES = `Ты — разборщик команд для рабочего dashboard проекта First Logic (разработка и производство усилителей для антенн).
Сообщение пишет участник команды. Определи намерение и заполни поля. Отвечай только JSON по схеме.

Намерения:
- create_task — сделать, проверить, купить, заказать, подготовить что-то («Купить 10 разъёмов SMA для 100W» — это задача, а не расход).
- update_task — изменить статус или срок существующей задачи по номеру (#12 готово, #5 в работу).
- create_expense — деньги уже потрачены («потратил», «оплатил», «заплатили»). Сумма обязательна.
- stock_in — пришли/добавь компоненты на склад («добавь 5 шт BLF188XR по 3200») — только если компонент есть в списке components; цена за штуку — в price.
- stock_out — списать/израсходовать со склада.
- create_component — добавить на склад компонент, которого нет в components.
- create_product / create_assembly — новое изделие / новый узел.
- add_note — заметка к изделию («запиши к 100W: …»).
- query — вопрос о данных (остатки, мои задачи, цена компонента). Ответ положи в answer, только по данным контекста; если данных нет — так и скажи.
- unknown — непонятно; в clarification напиши, что уточнить.

Правила:
- id бери ТОЛЬКО из контекста. Изделие «100W», «сотка», «200-ватный» — найди по названию/версии/артикулу; не уверен — оставь пусто.
- Относительные даты («завтра», «в пятницу», «до конца месяца») переводи в YYYY-MM-DD от сегодняшней даты.
- Приоритет: «срочно» — high, «очень срочно/горит» — critical, иначе normal.
- Суммы: «8500», «8,5к» = 8500, «3200 рублей» = RUB, «$150» = USD, «юаней» = CNY. Рубли по умолчанию.
- Категорию расхода подбери из expense_categories по смыслу (изготовление корпусов → Производство).
- confidence ниже 0.6, если сомневаешься в типе команды или в том, к какому изделию/компоненту она относится.`

export class LimitError extends Error {}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Сколько подождать по ответу 429: «retry in 12.3s» / retryDelay "12s"; null — не указано. */
function retryAfterMs(text: string): number | null {
  const m = text.match(/retry in ([\d.]+)s/i) ?? text.match(/"retryDelay":\s*"([\d.]+)s"/)
  return m ? Math.ceil(Number(m[1]) * 1000) : null
}

/**
 * Пробует модели по порядку (GEMINI_MODEL — список через запятую). Лимит (429):
 * если ждать до 15 секунд — ждёт и повторяет ту же модель один раз, иначе идёт
 * к следующей. Сбой Google (5xx) — один повтор, затем следующая. Модель не
 * найдена (404) — сразу к следующей.
 */
export async function parseMessage(text: string, ctx: Ctx, today: string, apiKey: string, models: string) {
  const context = {
    today, me: ctx.member.name,
    products: ctx.products, components: ctx.components.map(c => ({ id: c.id, name: c.name, sku: c.sku, unit: c.unit, stock: c.stock, price: c.price, currency: c.currency })),
    suppliers: ctx.suppliers, expense_categories: ctx.expense_categories, component_categories: ctx.component_categories,
    members: ctx.members, my_open_tasks: ctx.my_tasks,
  }
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: RULES }] },
    contents: [{ role: 'user', parts: [{ text: `Контекст:
${JSON.stringify(context)}

Сообщение:
"""
${text.slice(0, 2000)}
"""` }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: SCHEMA, maxOutputTokens: 2048 },
  })

  const list = models.split(',').map(m => m.trim()).filter(Boolean)
  const dead = new Set<string>() // 404/400: этой модели у нас нет — в повторных проходах пропускаем
  let limited = false
  let lastError = ''
  // до трёх проходов по списку: перегрузка Google обычно длится секунды
  for (let pass = 0; pass < 3; pass++) {
    let transient = false
    for (const model of list) {
      if (dead.has(model)) continue
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body,
      })
      if (r.ok) {
        const j = await r.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
        const raw = j.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
        console.log(`gemini ok model=${model} pass=${pass}`)
        return JSON.parse(raw) as Record<string, unknown>
      }
      const err = await r.text()
      lastError = `${model}: ${r.status} ${err.slice(0, 200)}`
      console.warn(`gemini ${lastError}`)
      if (r.status === 404 || r.status === 400) { dead.add(model); continue }
      if (r.status === 429 || r.status >= 500) {
        limited = true // для пользователя это «сервис перегружен, повторите»
        transient = true
        // короткий лимит: ждём и пробуем ту же модель ещё раз
        const wait = r.status === 429 ? retryAfterMs(err) : null
        if (wait !== null && wait <= 8_000) { await sleep(wait + 300); }
        continue
      }
      throw new Error(`gemini ${lastError}`)
    }
    if (!transient) break
    await sleep(2000 * (pass + 1))
  }
  if (limited) throw new LimitError(lastError)
  throw new Error(`gemini: ${lastError || 'нет моделей'}`)
}

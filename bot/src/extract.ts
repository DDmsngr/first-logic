// Задачи из документа (PDF, Word, текст): Gemini выделяет список, человек проверяет его в предпросмотре.
// Ничего не пишет в базу: возвращает только черновик задач в формате импорта dashboard.

export interface ExtractedTask {
  title: string
  description?: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  due?: string
  assignee?: string
  labels?: string[]
}

const S = (description: string) => ({ type: 'STRING', nullable: true, description })

export const EXTRACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    tasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Короткое название в повелительной форме, до 120 символов' },
          description: S('Контекст и критерии готовности из документа; можно списком'),
          priority: { type: 'STRING', nullable: true, enum: ['low', 'medium', 'high', 'critical'] },
          due: S('Срок YYYY-MM-DD, только если он назван в документе'),
          assignee: S('Исполнитель ровно так, как назван в документе; не выдумывай'),
          labels: { type: 'ARRAY', nullable: true, items: { type: 'STRING' }, description: 'До трёх коротких меток' },
        },
        required: ['title'],
      },
    },
  },
  required: ['tasks'],
}

export const EXTRACT_RULES = `Ты помогаешь команде, которая разрабатывает и производит радиоэлектронные изделия.
Из документа выдели конкретные задачи, которые нужно выполнить (что сделать, проверить, заказать, измерить, нарисовать).
Правила:
- Только действия, а не пересказ и не выводы. Одна задача — одно действие; крупный пункт разбей, если в нём несколько независимых шагов.
- Название — коротко и в повелительной форме («Проверить КСВ на 144 МГц»). Подробности, числа и допуски из документа — в description.
- Не выдумывай сроки и исполнителей: заполняй due и assignee, только если они прямо названы. Даты переводи в YYYY-MM-DD от сегодняшней даты.
- Приоритет high или critical — только если документ прямо говорит о срочности или блокере, иначе medium.
- Не больше 40 задач: самые существенные. Если задач в документе нет — верни пустой список.
- Язык — как в документе.`

export type ExtractInput = { text: string } | { pdfBase64: string }

/** Тело запроса к Gemini: PDF идёт как inline-файл, остальное — текстом документа. */
export function buildExtractRequest(input: ExtractInput, today: string, people: string[]) {
  const head = `Сегодня ${today}. Участники команды (для справки, не для выдумывания): ${people.slice(0, 30).join(', ') || '—'}.`
  const parts: Record<string, unknown>[] = 'text' in input
    ? [{ text: `${head}\n\nДокумент:\n"""\n${input.text.slice(0, 60_000)}\n"""` }]
    : [{ text: `${head}\n\nДокумент приложен файлом.` }, { inline_data: { mime_type: 'application/pdf', data: input.pdfBase64 } }]
  return JSON.stringify({
    systemInstruction: { parts: [{ text: EXTRACT_RULES }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: EXTRACT_SCHEMA, maxOutputTokens: 8192 },
  })
}

const PRIORITIES = ['low', 'medium', 'high', 'critical']
const DATE = /^\d{4}-\d{2}-\d{2}$/
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

/** Чистит ответ модели: пустое отбрасывается, приоритет и дата — только валидные, список ограничен. */
export function normalizeExtracted(raw: unknown): ExtractedTask[] {
  const list = (raw as { tasks?: unknown })?.tasks
  if (!Array.isArray(list)) return []
  const out: ExtractedTask[] = []
  for (const it of list) {
    const o = (it ?? {}) as Record<string, unknown>
    const title = str(o.title, 200)
    if (!title) continue
    const t: ExtractedTask = { title }
    const description = str(o.description, 4000)
    if (description) t.description = description
    if (typeof o.priority === 'string' && PRIORITIES.includes(o.priority)) t.priority = o.priority as ExtractedTask['priority']
    if (typeof o.due === 'string' && DATE.test(o.due)) t.due = o.due
    const assignee = str(o.assignee, 120)
    if (assignee) t.assignee = assignee
    const labels = Array.isArray(o.labels) ? o.labels.map(l => str(l, 40)).filter((l): l is string => !!l).slice(0, 3) : []
    if (labels.length) t.labels = labels
    out.push(t)
    if (out.length >= 40) break
  }
  return out
}

const MAX_TEXT = 200_000
const MAX_PDF_B64 = 14_000_000 // около 10 МБ файла

/** Проверка тела запроса от браузера. */
export function parseExtractBody(body: unknown):
  | { ok: true; input: ExtractInput; people: string[] }
  | { ok: false; error: string; status: number } {
  const b = (body ?? {}) as Record<string, unknown>
  const people = Array.isArray(b.people) ? b.people.filter((p): p is string => typeof p === 'string').map(p => p.slice(0, 80)).slice(0, 50) : []
  if (b.kind === 'text') {
    const text = typeof b.text === 'string' ? b.text.trim() : ''
    if (!text) return { ok: false, error: 'В документе не нашлось текста.', status: 400 }
    if (text.length > MAX_TEXT) return { ok: false, error: 'Документ слишком большой: до 200 тысяч знаков. Разбейте его на части.', status: 413 }
    return { ok: true, input: { text }, people }
  }
  if (b.kind === 'pdf') {
    const data = typeof b.pdf_base64 === 'string' ? b.pdf_base64 : ''
    if (!data) return { ok: false, error: 'Файл пустой.', status: 400 }
    if (data.length > MAX_PDF_B64) return { ok: false, error: 'PDF больше 10 МБ.', status: 413 }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 1000))) return { ok: false, error: 'Файл повреждён.', status: 400 }
    return { ok: true, input: { pdfBase64: data }, people }
  }
  return { ok: false, error: 'Неизвестный тип документа.', status: 400 }
}

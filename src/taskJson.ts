// Формат JSON-файла задач: разбор, проверка, экспорт, шаблон и описание для ИИ.
// Модуль чистый (без React и без сети), поэтому проверяется обычными node-тестами.

export const FORMAT_ID = 'first-logic-tasks'
export const MAX_TASKS = 200

export type Status = 'backlog' | 'todo' | 'in_progress' | 'review' | 'blocked' | 'done'
export type Priority = 'low' | 'medium' | 'high' | 'critical'

export interface PersonRef { name: string; email: string; user_id: string | null; status: string }

export interface ImportRow {
  index: number
  title: string
  description: string
  status: Status
  priority: Priority
  assigneeId: string | null
  assigneeName: string | null
  due: string | null
  labels: string[]
  errors: string[]
  warnings: string[]
  duplicate: boolean
}

export interface ParseResult { rows: ImportRow[]; fatal?: string }

const STATUS_ALIASES: Record<Status, string[]> = {
  backlog: ['backlog', 'бэклог', 'очередь'],
  todo: ['todo', 'to_do', 'к_выполнению', 'новая'],
  in_progress: ['in_progress', 'inprogress', 'в_работе', 'в_процессе'],
  review: ['review', 'на_проверке', 'ревью', 'проверка'],
  blocked: ['blocked', 'заблокирована', 'заблокировано', 'блок'],
  done: ['done', 'готово', 'выполнено', 'сделано', 'завершена'],
}
const PRIORITY_ALIASES: Record<Priority, string[]> = {
  low: ['low', 'низкий'],
  medium: ['medium', 'средний', 'обычный'],
  high: ['high', 'высокий'],
  critical: ['critical', 'критический', 'критичный', 'срочно'],
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '_')
const FREE_WORDS = ['', 'free', 'none', 'null', 'свободна', 'свободная', 'никому', 'не_назначен', 'не_назначена']

function pick<T extends string>(value: unknown, table: Record<T, string[]>, fallback: T, what: string, errors: string[]): T {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') { errors.push(`${what}: ожидалась строка`); return fallback }
  const n = norm(value)
  for (const key of Object.keys(table) as T[]) if (table[key].includes(n)) return key
  errors.push(`${what} «${value}» не подходит. Допустимо: ${(Object.keys(table) as T[]).join(', ')}`)
  return fallback
}

/** Исполнитель: email → полное имя → уникальное имя/фамилия/начало. Пусто или «свободна» = свободная задача. */
export function resolveAssignee(value: unknown, people: PersonRef[]): { id: string | null; name: string | null; error?: string } {
  if (value === undefined || value === null) return { id: null, name: null }
  if (typeof value !== 'string') return { id: null, name: null, error: 'assignee: ожидалась строка (имя или email) или null' }
  const q = value.trim().toLowerCase()
  if (FREE_WORDS.includes(norm(value))) return { id: null, name: null }
  const active = people.filter(p => p.status === 'active' && p.user_id)
  const found = (list: PersonRef[]) => list.length === 1 ? { id: list[0].user_id, name: list[0].name } : null

  const byEmail = active.filter(p => p.email.toLowerCase() === q)
  if (byEmail.length) return found(byEmail) ?? { id: null, name: null, error: `assignee «${value}»: неоднозначно` }
  const byFull = active.filter(p => p.name.toLowerCase() === q)
  if (byFull.length) return found(byFull) ?? { id: null, name: null, error: `assignee «${value}»: неоднозначно, укажите email` }
  const byPart = active.filter(p => p.name.toLowerCase().split(/\s+/).some(w => w === q || (q.length >= 3 && w.startsWith(q))))
  if (byPart.length === 1) return found(byPart)!
  if (byPart.length > 1) {
    return { id: null, name: null, error: `assignee «${value}»: подходят ${byPart.map(p => p.name).join(', ')} — укажите email` }
  }
  return { id: null, name: null, error: `assignee «${value}»: такого участника нет в команде` }
}

const isValidDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

const KNOWN = new Set(['title', 'description', 'status', 'priority', 'assignee', 'due', 'due_date', 'labels', 'num', 'id', 'created_at', 'comment'])

export function parseTaskFile(text: string, people: PersonRef[], existingTitles: string[]): ParseResult {
  let data: unknown
  try { data = JSON.parse(text.replace(/^﻿/, '')) }
  catch (e) { return { rows: [], fatal: `Это не корректный JSON: ${e instanceof Error ? e.message : e}` } }

  const list = Array.isArray(data) ? data
    : data && typeof data === 'object' && Array.isArray((data as { tasks?: unknown }).tasks) ? (data as { tasks: unknown[] }).tasks
    : null
  if (!list) return { rows: [], fatal: 'В файле нет списка задач: нужен массив или объект вида {"tasks": [...]}' }
  if (list.length === 0) return { rows: [], fatal: 'Список задач пуст' }
  if (list.length > MAX_TASKS) return { rows: [], fatal: `В файле ${list.length} задач, за один раз можно не больше ${MAX_TASKS}` }

  const have = new Set(existingTitles.map(t => t.trim().toLowerCase()))
  const seen = new Set<string>()

  const rows = list.map((item, i): ImportRow => {
    const errors: string[] = []
    const warnings: string[] = []
    const row: ImportRow = {
      index: i + 1, title: '', description: '', status: 'todo', priority: 'medium',
      assigneeId: null, assigneeName: null, due: null, labels: [], errors, warnings, duplicate: false,
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push('элемент должен быть объектом {…}'); return row }
    const o = item as Record<string, unknown>

    if (typeof o.title !== 'string' || !o.title.trim()) errors.push('нет названия (title)')
    else if (o.title.trim().length > 200) errors.push('название длиннее 200 символов')
    else row.title = o.title.trim()

    if (o.description !== undefined && o.description !== null) {
      if (typeof o.description !== 'string') errors.push('description: ожидалась строка')
      else if (o.description.length > 20000) errors.push('description длиннее 20 000 символов')
      else row.description = o.description
    }

    row.status = pick(o.status, STATUS_ALIASES, 'todo', 'status', errors)
    row.priority = pick(o.priority, PRIORITY_ALIASES, 'medium', 'priority', errors)

    const a = resolveAssignee(o.assignee, people)
    row.assigneeId = a.id
    row.assigneeName = a.name
    if (a.error) errors.push(a.error)

    const due = o.due ?? o.due_date
    if (due !== undefined && due !== null && due !== '') {
      if (typeof due !== 'string' || !isValidDate(due)) errors.push(`срок «${String(due)}»: нужна дата ГГГГ-ММ-ДД`)
      else row.due = due
    }

    if (o.labels !== undefined && o.labels !== null) {
      const raw = Array.isArray(o.labels) ? o.labels : typeof o.labels === 'string' ? o.labels.split(',') : null
      if (!raw || raw.some(l => typeof l !== 'string')) errors.push('labels: ожидался список строк')
      else {
        const clean = [...new Set((raw as string[]).map(l => l.trim()).filter(Boolean))]
        if (clean.some(l => l.length > 40)) errors.push('метка длиннее 40 символов')
        if (clean.length > 10) errors.push('не больше 10 меток на задачу')
        row.labels = clean
      }
    }

    const unknown = Object.keys(o).filter(k => !KNOWN.has(k))
    if (unknown.length) warnings.push(`неизвестные поля будут проигнорированы: ${unknown.join(', ')}`)

    const key = row.title.toLowerCase()
    if (key && (have.has(key) || seen.has(key))) row.duplicate = true
    if (key) seen.add(key)
    return row
  })
  return { rows }
}

// ── экспорт, шаблон, описание ───────────────────────────────────────────────

interface ExportTask {
  num: number; title: string; description: string; status: string; priority: string
  assignee_id: string | null; due_date: string | null; label_ids: string[]
}

export function buildExport(tasks: ExportTask[], people: PersonRef[], labelName: (id: string) => string | undefined) {
  const emailOf = (id: string | null) => (id ? people.find(p => p.user_id === id)?.email ?? null : null)
  return {
    format: FORMAT_ID,
    version: 1,
    exported_at: new Date().toISOString(),
    tasks: tasks.map(t => ({
      num: t.num,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      assignee: emailOf(t.assignee_id),
      due: t.due_date,
      labels: t.label_ids.map(labelName).filter(Boolean),
    })),
  }
}

export function buildTemplate(firstPersonEmail: string | null) {
  return {
    format: FORMAT_ID,
    version: 1,
    tasks: [
      { title: 'Фильтры на карте', description: 'Что сделать:\n- фильтр по категориям\n- сохранение выбора', priority: 'high', labels: ['карта'] },
      { title: 'Иконки для событий', description: 'Нарисовать 12 иконок, светлая и тёмная тема', priority: 'medium', due: '2026-10-15' },
      { title: 'Починить вход через VK', description: 'Иногда после редиректа пустой экран', status: 'todo', priority: 'critical', assignee: firstPersonEmail ?? 'Алексей', labels: ['баг'] },
    ],
  }
}

/** Текст, который можно отдать любому ИИ-ассистенту вместе с описанием задач. */
export const AI_PROMPT = `Составь JSON-файл с задачами для импорта в First Logic.

Верни только JSON, без пояснений, в таком виде:
{
  "format": "first-logic-tasks",
  "version": 1,
  "tasks": [
    {
      "title": "Короткое название (обязательно, до 200 символов)",
      "description": "Подробности, можно Markdown",
      "priority": "low | medium | high | critical",
      "status": "backlog | todo | in_progress | review | blocked | done",
      "assignee": "имя или email участника; null или поле не указывать = свободная задача, её возьмёт любой",
      "due": "ГГГГ-ММ-ДД",
      "labels": ["метка1", "метка2"]
    }
  ]
}

Правила: обязательно только title. Не указано status — todo, не указано priority — medium. Максимум 200 задач. Даты только в формате ГГГГ-ММ-ДД. Если исполнитель не назван — не подставляй его, оставь задачу свободной.`

// Серийные номера: разбор списка и генерация ряда. Чистые функции.

/** Список номеров: по строкам или через запятую и точку с запятой, без пустых. */
export function parseSerials(text: string) {
  return text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
}

/** Ряд по образцу: FL-0012, 3 → FL-0012, FL-0013, FL-0014 (число цифр сохраняется). Без цифр на конце — пусто. */
export function serialRange(start: string, count: number) {
  const m = start.trim().match(/^(.*?)(\d+)$/)
  if (!m || !Number.isInteger(count) || count < 1) return []
  const [, prefix, digits] = m
  return Array.from({ length: count }, (_, i) => `${prefix}${String(Number(digits) + i).padStart(digits.length, '0')}`)
}

/** Что не так со списком номеров (null — всё в порядке). */
export function serialsProblem(serials: string[], qty: number) {
  if (serials.length === 0) return null
  if (!Number.isInteger(qty)) return 'С номерами количество должно быть целым'
  if (serials.length !== qty) return `Номеров ${serials.length}, а собрано ${qty} — должно совпадать`
  const seen = new Set<string>()
  for (const s of serials) {
    const k = s.toLowerCase()
    if (seen.has(k)) return `Номер «${s}» повторяется`
    seen.add(k)
  }
  return null
}

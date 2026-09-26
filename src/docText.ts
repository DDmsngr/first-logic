// Чтение документа в браузере: из Word достаём текст (в том числе таблицы), PDF отдаём как есть.
import { unzipSync, strFromU8 } from 'fflate'

export type DocContent = { kind: 'text'; text: string } | { kind: 'pdf'; base64: string }

const MB = 1024 * 1024
export const MAX_DOC_BYTES = 10 * MB

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, m => ENT[m]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))

/**
 * Текст из word/document.xml: абзацы — строки, строка таблицы — ячейки через « | ».
 * Разбор по тегам без DOM, чтобы работало и в браузере, и в тестах.
 */
export function docxXmlToText(xml: string): string {
  const lines: string[] = []
  let para = ''
  let inTable = 0
  let row: string[] = []
  let cell: string[] = []
  const re = /<(\/?)w:(tbl|tr|tc|p|t|tab|br)\b[^>]*?(\/?)>|([^<]+)/g
  let inText = false
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const [, close, tag, selfClose, text] = m
    if (text !== undefined) { if (inText) para += unescapeXml(text); continue }
    if (tag === 't') { inText = !close && !selfClose; continue }
    if (tag === 'tab' && !close) { para += '\t'; continue }
    if (tag === 'br' && !close) { para += '\n'; continue }
    if (tag === 'tbl') { inTable += close ? -1 : 1; continue }
    if (tag === 'p' && close) {
      const t = para.trim()
      para = ''
      if (inTable > 0) { if (t) cell.push(t) } else lines.push(t)
      continue
    }
    if (tag === 'tc' && close) { row.push(cell.join(' ')); cell = []; continue }
    if (tag === 'tr' && close) { if (row.some(c => c)) lines.push(row.join(' | ')); row = []; continue }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function docxToText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: f => f.name === 'word/document.xml' })
  const doc = files['word/document.xml']
  if (!doc) throw new Error('Это не документ Word (.docx): не нашёл текст внутри.')
  return docxXmlToText(strFromU8(doc))
}

const toBase64 = (bytes: Uint8Array) => {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Читает файл для разбора ИИ: PDF — как есть, Word и текст — в текст. */
export async function readDocument(file: File): Promise<DocContent> {
  if (file.size > MAX_DOC_BYTES) throw new Error('Файл больше 10 МБ.')
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return { kind: 'pdf', base64: toBase64(new Uint8Array(await file.arrayBuffer())) }
  if (name.endsWith('.docx')) {
    const text = docxToText(new Uint8Array(await file.arrayBuffer()))
    if (!text) throw new Error('В документе не нашлось текста.')
    return { kind: 'text', text }
  }
  if (name.endsWith('.doc')) throw new Error('Старый формат .doc не читается: сохраните файл как .docx или PDF.')
  if (name.endsWith('.xls') || name.endsWith('.xlsx')) throw new Error('Таблицы Excel не читаются: сохраните лист как PDF или CSV.')
  const text = (await file.text()).trim()
  if (!text) throw new Error('Файл пустой.')
  return { kind: 'text', text }
}

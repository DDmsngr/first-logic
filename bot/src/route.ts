// Что из входящего сообщения считать командой боту. В личке — всё; в группе —
// только команды (/tasks, /tasks@бот), упоминание бота и ответ на его сообщение.

export interface RouteOpts { username: string; botId: number; replyToId?: number }

export const isGroupChat = (type: string) => type === 'group' || type === 'supergroup'

/** Очищенный текст команды или null, если сообщение боту не адресовано. */
export function routeText(chatType: string, raw: string, o: RouteOpts): string | null {
  const text = raw.trim()
  if (!text) return null
  if (chatType === 'private') return text
  if (!isGroupChat(chatType)) return null

  // String.raw: \b должен дойти до регулярки, а не стать символом забоя
  const mention = String.raw`@${o.username}\b`
  const has = new RegExp(mention, 'i')
  const strip = (s: string) => s.replace(new RegExp(mention, 'ig'), '').replace(/\s+/g, ' ').trim()

  const cmd = text.match(/^\/(\w+)(?:@(\w+))?/)
  if (cmd) {
    if (cmd[2] && cmd[2].toLowerCase() !== o.username.toLowerCase()) return null // команда другому боту
    return strip(text)
  }
  if (!has.test(text) && o.replyToId !== o.botId) return null
  return strip(text) || null
}

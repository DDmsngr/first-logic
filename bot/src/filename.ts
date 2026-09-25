// Имя файла для ключа в хранилище. Supabase Storage отвергает не-ASCII в ключе
// («Invalid key»), поэтому кириллицу транслитерируем, остальное заменяем на «_».
// Настоящее имя лежит в ws_attachments.filename и показывается пользователю как есть.

const RU: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

export function storageName(name: string, max = 120) {
  const t = Array.from(name.normalize('NFC')).map(ch => {
    const low = ch.toLowerCase()
    const r = RU[low]
    if (r === undefined) return ch
    return ch === low ? r : r.charAt(0).toUpperCase() + r.slice(1)
  }).join('')
  const clean = t.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+/, '')
  return (clean || 'file').slice(-max)
}

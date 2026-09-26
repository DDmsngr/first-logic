import { useEffect, useState } from 'react'
import { Download, Smartphone } from 'lucide-react'

interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)

/** Установка как приложения: кнопка там, где браузер это умеет, подсказка для iPhone. */
export function InstallApp() {
  const [ev, setEv] = useState<InstallEvent | null>(null)
  const [installed, setInstalled] = useState(standalone())

  useEffect(() => {
    const before = (e: Event) => { e.preventDefault(); setEv(e as InstallEvent) }
    const done = () => { setInstalled(true); setEv(null) }
    window.addEventListener('beforeinstallprompt', before)
    window.addEventListener('appinstalled', done)
    return () => { window.removeEventListener('beforeinstallprompt', before); window.removeEventListener('appinstalled', done) }
  }, [])

  return (
    <section className="dash-card mb-4 p-5" aria-label="Приложение">
      <h2 className="dash-label mb-3">Приложение на телефоне</h2>
      {installed
        ? <p className="flex items-center gap-2 text-sm"><Smartphone className="h-4 w-4" aria-hidden /> Установлено: вы открыли First Logic как приложение.</p>
        : ev
          ? <button className="dash-btn" onClick={() => { void ev.prompt().then(() => ev.userChoice).then(() => setEv(null)) }}><Download className="h-4 w-4" aria-hidden /> Установить</button>
          : <p className="dash-muted text-sm">
              {isIos()
                ? 'На iPhone: кнопка «Поделиться» в Safari → «На экран „Домой“».'
                : 'В Chrome на телефоне: меню ⋮ → «Установить приложение» (или «Добавить на главный экран»). Значок появится на экране, сайт откроется без адресной строки.'}
            </p>}
    </section>
  )
}

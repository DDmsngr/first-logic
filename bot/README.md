# @first_logic_bot

Telegram-вход в dashboard First Logic. Cloudflare Worker: принимает сообщения
(webhook), разбирает их через Gemini, выполняет команду в той же базе Supabase,
что и dashboard (функция `fl_bot_apply`, от имени привязанного участника), и
раз в минуту отправляет уведомления из очереди `fl_outbox`.

```
Telegram → Worker (/webhook) → Gemini (разбор) → fl_bot_apply → база → dashboard
dashboard → триггеры базы → fl_outbox → Worker (cron) → Telegram
```

Деньги, склад и новые записи справочников — только после кнопки «Создать».
Задачи — сразу, если разбор уверенный.

## Установка (один раз)

Нужны миграции `0011`–`0013` в базе.

```bash
cd bot
npm install
npx wrangler login          # аккаунт Cloudflare
npx wrangler deploy         # создаст first-logic-bot.<ваш-поддомен>.workers.dev

npx wrangler secret put BOT_TOKEN              # токен от @BotFather
npx wrangler secret put GEMINI                 # ключ Gemini API
npx wrangler secret put SUPABASE_SERVICE_KEY   # Supabase → Settings → API Keys → Secret key
npx wrangler secret put WEBHOOK_SECRET         # любая длинная случайная строка (латиница, цифры, -)
```

Потом один раз открыть в браузере:

```
https://first-logic-bot.<ваш-поддомен>.workers.dev/setup?key=<WEBHOOK_SECRET>
```

Ответ `webhook set` — бот подключён. Дальше каждый участник: dashboard →
Настройки → Telegram → «Привязать».

## Разработка

```bash
npm test                    # разбор команд (без сети)
npx wrangler tail --format pretty   # живой лог
```

Модель Gemini задаётся в `wrangler.toml` (`GEMINI_MODEL`).

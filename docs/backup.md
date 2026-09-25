# Резервные копии First Logic

Раз в неделю (воскресенье, 06:00 МСК) GitHub Actions делает копию: база данных
и все файлы из хранилища (документы, фото, аватары). Архив шифруется паролем
и лежит в Actions → «Резервная копия» → нужный запуск → Artifacts, 90 дней.
Запустить вне расписания: там же кнопка **Run workflow**.

## Настройка (один раз)

GitHub → репозиторий → Settings → Secrets and variables → Actions → **New repository secret**:

| Секрет | Где взять |
|---|---|
| `SUPABASE_DB_URL` | Supabase → кнопка **Connect** (сверху) → вкладка Direct → **Session pooler** → строка `postgresql://postgres.xxxx:[YOUR-PASSWORD]@…pooler.supabase.com:5432/postgres`. Вместо `[YOUR-PASSWORD]` — пароль базы, заданный при создании проекта (забыли — Settings → Database → Reset database password). Нужен именно Session pooler: «Direct connection» у бесплатного тарифа только по IPv6, GitHub его не умеет. |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API Keys → Secret key (`sb_secret_…`). Тот же, что у бота. Без него копируется только база, без файлов. |
| `BACKUP_PASSPHRASE` | Придумайте длинный пароль и **сохраните в менеджер паролей**. Без него копию не расшифровать — ни вам, ни мне. |

Потом Actions → «Резервная копия» → Run workflow → через пару минут должен появиться артефакт.

## Восстановление

1. Скачайте артефакт, распакуйте zip — внутри `first-logic-ДАТА.tar.gz.gpg`.
2. Расшифруйте и распакуйте (Git Bash на Windows):
   ```bash
   gpg -d first-logic-ДАТА.tar.gz.gpg > backup.tar.gz   # спросит BACKUP_PASSPHRASE
   mkdir backup && tar -xzf backup.tar.gz -C backup
   ```
   Внутри: `db.dump` (база) и `storage/` (файлы по бакетам).
3. **База** — в новый пустой проект Supabase: сначала выполнить миграции `supabase/migrations` по порядку (как при первом запуске), затем залить данные:
   ```bash
   pg_restore --data-only --disable-triggers --no-owner -d "СТРОКА_ПОДКЛЮЧЕНИЯ_НОВОГО_ПРОЕКТА" backup/db.dump
   ```
   Частичное восстановление (одна таблица): `pg_restore -t fl_components …`.
4. **Файлы** — залить папки `storage/ws-files` и `storage/avatars` в одноимённые бакеты (Supabase → Storage → Upload, или скрипт).

Если что-то пошло не так — не удаляйте старый проект, пока новый не проверен.

## Заодно

Бесплатный проект Supabase «засыпает», если к нему неделю никто не обращается.
Бот опрашивает базу каждую минуту, поэтому, пока бот работает, проект не уснёт.

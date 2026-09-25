-- Профиль участника: должность, телефон, фото.
--
-- Свой профиль правит сам участник; роль и статус по-прежнему только через
-- ws_members_guard. Права на колонки выдаются явно (см. 0001: сначала revoke all).

alter table ws_members
  add column position text check (position is null or length(position) <= 80),
  add column phone    text check (phone is null or length(phone) <= 40);

grant update (name, avatar_url, position, phone) on ws_members to authenticated;

create policy "участник правит свой профиль" on ws_members
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Политика админов даёт им право менять строки, поэтому чужие профильные поля
-- закрываем триггером: админ правит только незанятые приглашения (имя до входа).
create or replace function ws_members_guard() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if auth.uid() is null then return new; end if;  -- сервисный доступ
  if current_setting('ws.accepting', true) = '1' then return new; end if;
  if (new.name, new.avatar_url, new.position, new.phone)
       is distinct from (old.name, old.avatar_url, old.position, old.phone)
     and old.user_id is not null and old.user_id <> auth.uid() then
    raise exception 'профиль правит только сам участник';
  end if;
  if new.role is distinct from old.role or new.status is distinct from old.status then
    if old.user_id = auth.uid() then
      raise exception 'свою роль и статус менять нельзя';
    end if;
    if old.role = 'owner' or new.role = 'owner' then
      raise exception 'роль owner не меняется через интерфейс';
    end if;
    if new.role = 'admin' and ws_role(old.workspace_id) <> 'owner' then
      raise exception 'администраторов назначает только owner';
    end if;
    if old.status = 'invited' and new.status <> 'invited' then
      raise exception 'приглашённый становится активным только по токену';
    end if;
  end if;
  return new;
end
$$;

-- ── фото ────────────────────────────────────────────────────────────────────
-- Публичный бакет: аватар показывается обычным <img> без подписанных ссылок.
-- Имена файлов не угадываются (<user_id>/<время>.jpg), а сами фото не секрет.
-- Клиент уменьшает снимок до 256×256, поэтому лимит маленький.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "avatars: свои файлы видно владельцу" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and split_part(name, '/', 1) = auth.uid()::text);

create policy "avatars: грузить только в свою папку" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and split_part(name, '/', 1) = auth.uid()::text);

create policy "avatars: удалять только свои" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and split_part(name, '/', 1) = auth.uid()::text);

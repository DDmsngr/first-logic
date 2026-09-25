-- Видимость активности: всегда / по расписанию / никогда.
-- Скрываем на сервере: вне разрешённого времени ws_touch просто не пишет last_seen,
-- в режиме «никогда» last_seen стирается. Остальные видят «скрыта» или последнее
-- время, когда участник был виден.

alter table ws_members
  add column presence_mode text not null default 'always' check (presence_mode in ('always', 'schedule', 'never')),
  add column presence_from time not null default '09:00',
  add column presence_to   time not null default '19:00',
  add column presence_tz   text not null default 'Europe/Moscow' check (length(presence_tz) <= 64);

grant update (presence_mode, presence_from, presence_to, presence_tz) on ws_members to authenticated;

-- Окно через полночь (22:00–06:00) тоже поддерживается.
create function ws_presence_visible(p_mode text, p_from time, p_to time, p_tz text) returns boolean
language plpgsql stable
set search_path = public
as $$
declare t time;
begin
  if p_mode = 'always' then return true; end if;
  if p_mode = 'never' then return false; end if;
  begin
    t := (now() at time zone p_tz)::time;
  exception when others then
    t := (now() at time zone 'Europe/Moscow')::time;
  end;
  if p_from <= p_to then return t >= p_from and t < p_to; end if;
  return t >= p_from or t < p_to;
end
$$;

create or replace function ws_touch(p_ws uuid) returns void
language sql security definer
set search_path = public
set row_security = off
as $$
  update ws_members set last_seen = now()
  where workspace_id = p_ws and user_id = auth.uid() and status = 'active'
    and (last_seen is null or last_seen < now() - interval '1 minute')
    and ws_presence_visible(presence_mode, presence_from, presence_to, presence_tz)
$$;

-- Чужую видимость не меняет никто, включая админов (их политика даёт update строки).
create function ws_members_presence_guard() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if auth.uid() is not null
     and (new.presence_mode, new.presence_from, new.presence_to, new.presence_tz)
         is distinct from (old.presence_mode, old.presence_from, old.presence_to, old.presence_tz)
     and old.user_id is distinct from auth.uid() then
    raise exception 'видимость активности меняет только сам участник';
  end if;
  if new.presence_mode = 'never' then new.last_seen := null; end if;
  return new;
end
$$;

create trigger ws_members_presence_guard before update on ws_members
  for each row execute function ws_members_presence_guard();

revoke execute on function ws_presence_visible, ws_members_presence_guard from public, anon;
grant execute on function ws_presence_visible to authenticated, service_role;

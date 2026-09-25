-- Фаза 4: курсы валют, справочники, поставщики, компоненты.
--
-- Все роли в команде равны, поэтому писать в эти таблицы может любой активный
-- участник workspace (ws_is_member). Права на таблицы выдаются явно: в проекте
-- выключено «Automatically expose new tables».

-- ── курсы валют ─────────────────────────────────────────────────────────────
-- Курс ЦБ подтягивает сама база раз в сутки (pg_cron + http). Ручной курс,
-- если задан, перекрывает курс ЦБ; оба видны в интерфейсе.

create extension if not exists http with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create table fl_rates (
  currency     text primary key check (currency in ('USD', 'CNY', 'EUR')),
  cbr_rate     numeric(14, 6),          -- рублей за 1 единицу валюты
  cbr_date     date,
  fetched_at   timestamptz,
  manual_rate  numeric(14, 6) check (manual_rate is null or manual_rate > 0),
  updated_at   timestamptz not null default now()
);
insert into fl_rates (currency) values ('USD'), ('CNY'), ('EUR');

create function fl_rate(p_currency text) returns numeric
language sql stable
set search_path = public
as $$
  select case when p_currency = 'RUB' then 1
              else (select coalesce(manual_rate, cbr_rate) from fl_rates where currency = p_currency) end
$$;

create function fl_to_rub(p_amount numeric, p_currency text) returns numeric
language sql stable
set search_path = public
as $$ select p_amount * fl_rate(p_currency) $$;

-- Чаще раза в 10 минут не ходит: кнопку «Обновить» могут жать все подряд.
create function fl_refresh_rates(p_force boolean default false) returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  r extensions.http_response;
  j jsonb;
begin
  if not p_force and exists (select 1 from fl_rates where fetched_at > now() - interval '10 minutes') then
    return;
  end if;
  select * into r from extensions.http_get('https://www.cbr-xml-daily.ru/daily_json.js');
  if r.status <> 200 then
    raise exception 'источник курсов ответил %', r.status;
  end if;
  j := r.content::jsonb;
  update fl_rates f
     set cbr_rate   = (j -> 'Valute' -> f.currency ->> 'Value')::numeric
                    / (j -> 'Valute' -> f.currency ->> 'Nominal')::numeric,
         cbr_date   = (j ->> 'Date')::timestamptz::date,
         fetched_at = now(),
         updated_at = now()
   where j -> 'Valute' ? f.currency;
end
$$;
revoke all on function fl_refresh_rates from public, anon;

create function fl_rates_guard() returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and not exists (
       select 1 from ws_members where user_id = auth.uid() and status = 'active') then
    raise exception 'нет доступа';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger fl_rates_guard before update on fl_rates
  for each row execute function fl_rates_guard();

-- ЦБ публикует курс на завтра около 11:30 МСК; 09:15 UTC = 12:15 МСК.
select cron.schedule('fl-rates-daily', '15 9 * * *', $$select public.fl_refresh_rates(true)$$);

do $$
begin
  perform fl_refresh_rates(true);
exception when others then
  raise notice 'курсы не загрузились сейчас (%), подтянутся по расписанию', sqlerrm;
end $$;

-- ── справочники (категории, статусы) ────────────────────────────────────────

create table fl_dicts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  kind          text not null check (kind in ('component_category', 'expense_category', 'product_status')),
  name          text not null check (length(trim(name)) between 1 and 60),
  color         text not null default '#8795a3' check (color ~ '^#[0-9a-fA-F]{6}$'),
  position      int not null default 0,
  created_at    timestamptz not null default now()
);
create unique index fl_dicts_name_uq on fl_dicts (workspace_id, kind, lower(name));

insert into fl_dicts (workspace_id, kind, name, color, position)
select w.id, 'component_category', c.name, c.color, c.pos
from ws_workspaces w
cross join (values
  ('Электроника', '#5ec4e6', 1), ('Механика', '#a3b0bd', 2), ('Разъёмы', '#f2b94b', 3),
  ('Кабели', '#e0a458', 4), ('Платы (PCB)', '#5fd08f', 5), ('Крепёж', '#8795a3', 6),
  ('Корпуса', '#b49cf0', 7), ('Охлаждение', '#6ea8fe', 8), ('Модули', '#f08bb4', 9),
  ('Прочее', '#6b7785', 10)
) as c(name, color, pos)
where w.slug = 'first-logic';

-- ── поставщики ──────────────────────────────────────────────────────────────

create table fl_suppliers (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 120),
  contact       text,
  website       text,
  telegram      text,
  phone         text,
  email         text,
  notes         text not null default '',
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz
);
create unique index fl_suppliers_name_uq on fl_suppliers (workspace_id, lower(name));

-- ── компоненты ──────────────────────────────────────────────────────────────

create table fl_components (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 200),
  category_id   uuid references fl_dicts(id) on delete set null,
  sku           text,
  manufacturer  text,
  supplier_id   uuid references fl_suppliers(id) on delete set null,
  url           text,
  unit          text not null default 'шт' check (length(trim(unit)) between 1 and 12),
  price         numeric(14, 4) not null default 0 check (price >= 0),
  currency      text not null default 'RUB' check (currency in ('RUB', 'USD', 'CNY', 'EUR')),
  stock         numeric(14, 3) not null default 0,
  min_stock     numeric(14, 3) not null default 0 check (min_stock >= 0),
  status        text not null default 'active' check (status in ('active', 'ordered', 'obsolete')),
  location      text,
  notes         text not null default '',
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz
);
create index fl_components_ws_idx on fl_components (workspace_id, name);
create index fl_components_supplier_idx on fl_components (supplier_id);

-- ── служебные триггеры ──────────────────────────────────────────────────────

create function fl_touch_updated() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
create trigger fl_suppliers_touch before update on fl_suppliers
  for each row execute function fl_touch_updated();
create trigger fl_components_touch before update on fl_components
  for each row execute function fl_touch_updated();

-- Категория должна быть из того же workspace и нужного вида.
create function fl_components_check() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.category_id is not null and not exists (
       select 1 from fl_dicts where id = new.category_id
         and workspace_id = new.workspace_id and kind = 'component_category') then
    raise exception 'категория не найдена';
  end if;
  if new.supplier_id is not null and not exists (
       select 1 from fl_suppliers where id = new.supplier_id and workspace_id = new.workspace_id) then
    raise exception 'поставщик не найден';
  end if;
  return new;
end
$$;
create trigger fl_components_check before insert or update on fl_components
  for each row execute function fl_components_check();

-- Журнал: создание, цена, остаток. Текст события собирает интерфейс из meta.
create function fl_components_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if tg_op = 'INSERT' then
    perform ws_log(new.workspace_id, null, 'component', new.id, 'component.created',
                   jsonb_build_object('title', new.name));
    return new;
  end if;
  if (new.price, new.currency) is distinct from (old.price, old.currency) then
    perform ws_log(new.workspace_id, null, 'component', new.id, 'component.price',
                   jsonb_build_object('title', new.name,
                                      'from', old.price::text || ' ' || old.currency,
                                      'to', new.price::text || ' ' || new.currency));
  end if;
  if new.stock is distinct from old.stock then
    perform ws_log(new.workspace_id, null, 'component', new.id, 'component.stock',
                   jsonb_build_object('title', new.name, 'from', old.stock::text, 'to', new.stock::text,
                                      'unit', new.unit));
  end if;
  if new.archived_at is distinct from old.archived_at then
    perform ws_log(new.workspace_id, null, 'component', new.id,
                   case when new.archived_at is null then 'component.restored' else 'component.archived' end,
                   jsonb_build_object('title', new.name));
  end if;
  return new;
end
$$;
create trigger fl_components_log after insert or update on fl_components
  for each row execute function fl_components_log();

create function fl_suppliers_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  perform ws_log(new.workspace_id, null, 'supplier', new.id, 'supplier.created',
                 jsonb_build_object('title', new.name));
  return new;
end
$$;
create trigger fl_suppliers_log after insert on fl_suppliers
  for each row execute function fl_suppliers_log();

-- ── файлы: фото и документы компонентов и поставщиков ──────────────────────

alter table ws_attachments
  add column component_id uuid references fl_components(id) on delete cascade,
  add column supplier_id  uuid references fl_suppliers(id) on delete cascade;
alter table ws_attachments drop constraint ws_attachments_check;
alter table ws_attachments add constraint ws_attachments_target_check
  check (num_nonnulls(task_id, message_id, component_id, supplier_id) = 1);
create index ws_attachments_component_idx on ws_attachments (component_id);
create index ws_attachments_supplier_idx on ws_attachments (supplier_id);

create or replace function ws_attachments_before() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  new.workspace_id := coalesce(
    ws_task_ws(new.task_id),
    (select workspace_id from ws_messages where id = new.message_id),
    (select workspace_id from fl_components where id = new.component_id),
    (select workspace_id from fl_suppliers where id = new.supplier_id)
  );
  if new.workspace_id is null then raise exception 'к чему привязан файл — не найдено'; end if;
  if auth.uid() is not null then new.uploader_id := auth.uid(); end if;
  if split_part(new.storage_path, '/', 1) <> new.workspace_id::text then
    raise exception 'путь файла должен начинаться с id workspace';
  end if;
  return new;
end
$$;

drop policy "файл добавляет участник" on ws_attachments;
create policy "файл добавляет участник" on ws_attachments
  for insert to authenticated with check (
    uploader_id = auth.uid()
    and (
      (task_id is not null and ws_is_member(ws_task_ws(task_id)))
      or (message_id is not null and exists (
            select 1 from ws_messages m where m.id = message_id and ws_can_read_conv(m.conversation_id)))
      or (component_id is not null and exists (
            select 1 from fl_components c where c.id = component_id and ws_is_member(c.workspace_id)))
      or (supplier_id is not null and exists (
            select 1 from fl_suppliers s where s.id = supplier_id and ws_is_member(s.workspace_id)))
    )
  );

-- ── поиск: плюс компоненты и поставщики ─────────────────────────────────────

create or replace function ws_search(p_ws uuid, p_q text) returns jsonb
language plpgsql stable
as $$
declare
  v_like text := '%' || replace(replace(replace(trim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_num  text := ltrim(trim(p_q), '#');
begin
  if length(trim(p_q)) < 2 and v_num !~ '^\d+$' then
    return jsonb_build_object('tasks', '[]'::jsonb, 'members', '[]'::jsonb, 'messages', '[]'::jsonb,
                              'files', '[]'::jsonb, 'components', '[]'::jsonb, 'suppliers', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(x) from (
      select id, num, title, status from ws_tasks
      where workspace_id = p_ws and archived_at is null
        and (title ilike v_like or description ilike v_like or num::text = v_num)
      order by updated_at desc limit 8) x), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(x) from (
      select user_id, name, email, role from ws_members
      where workspace_id = p_ws and status = 'active' and (name ilike v_like or email ilike v_like)
      limit 8) x), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(x) from (
      select id, conversation_id, body, created_at from ws_messages
      where workspace_id = p_ws and deleted_at is null and body ilike v_like
      order by created_at desc limit 8) x), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(x) from (
      select id, task_id, component_id, supplier_id, filename, size from ws_attachments
      where workspace_id = p_ws and filename ilike v_like
      order by created_at desc limit 8) x), '[]'::jsonb),
    'components', coalesce((select jsonb_agg(x) from (
      select id, name, sku, manufacturer, stock, unit from fl_components
      where workspace_id = p_ws and archived_at is null
        and (name ilike v_like or sku ilike v_like or manufacturer ilike v_like or notes ilike v_like)
      order by name limit 8) x), '[]'::jsonb),
    'suppliers', coalesce((select jsonb_agg(x) from (
      select id, name, contact from fl_suppliers
      where workspace_id = p_ws and archived_at is null
        and (name ilike v_like or contact ilike v_like or email ilike v_like or telegram ilike v_like)
      order by name limit 8) x), '[]'::jsonb)
  );
end
$$;

-- ── RLS и права ─────────────────────────────────────────────────────────────

alter table fl_rates      enable row level security;
alter table fl_dicts      enable row level security;
alter table fl_suppliers  enable row level security;
alter table fl_components enable row level security;

create policy "курсы видят все вошедшие" on fl_rates
  for select to authenticated using (true);
create policy "ручной курс ставит участник" on fl_rates
  for update to authenticated
  using (exists (select 1 from ws_members where user_id = auth.uid() and status = 'active'))
  with check (true);

create policy "справочники: участники" on fl_dicts
  for all to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));
create policy "поставщики: участники" on fl_suppliers
  for all to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));
create policy "компоненты: участники" on fl_components
  for all to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));

revoke all on fl_rates, fl_dicts, fl_suppliers, fl_components from anon, authenticated;
grant select on fl_rates to authenticated;
grant update (manual_rate) on fl_rates to authenticated;
grant select, insert, update, delete on fl_dicts, fl_suppliers, fl_components to authenticated;
grant execute on function fl_rate, fl_to_rub, fl_refresh_rates to authenticated;

alter publication supabase_realtime add table fl_rates, fl_dicts, fl_suppliers, fl_components;

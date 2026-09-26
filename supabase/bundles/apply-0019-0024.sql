-- Пакет миграций 0019–0024 одним файлом для SQL Editor (Supabase). Выполняется целиком: при ошибке ни одна не применится.

-- ═══ 0019_stocktake.sql ═══
-- Инвентаризация склада: пересчитали руками → расхождения с учётом → одним действием
-- исправили остатки с пометкой «Инвентаризация №N» в истории каждого компонента.

create table fl_stocktakes (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  num           int not null,
  title         text not null default '',
  status        text not null default 'draft' check (status in ('draft', 'applied', 'cancelled')),
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  applied_at    timestamptz,
  applied_by    uuid references auth.users(id) on delete set null,
  unique (workspace_id, num)
);
create index fl_stocktakes_ws_idx on fl_stocktakes (workspace_id, created_at desc);

create table fl_stocktake_lines (
  id            uuid primary key default gen_random_uuid(),
  stocktake_id  uuid not null references fl_stocktakes(id) on delete cascade,
  component_id  uuid not null references fl_components(id) on delete cascade,
  -- снимок на момент начала: компонент могут переименовать, а остаток — изменить во время подсчёта
  name          text not null,
  sku           text,
  unit          text not null default 'шт',
  location      text,
  expected      numeric(14, 3) not null,
  counted       numeric(14, 3) check (counted is null or counted >= 0),
  -- что реально изменилось при применении (относительно остатка в тот момент)
  applied_delta numeric(14, 3),
  unique (stocktake_id, component_id)
);
create index fl_stocktake_lines_idx on fl_stocktake_lines (stocktake_id);

-- Номер по контуру, как у заказов.
create function fl_stocktakes_before() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  perform pg_advisory_xact_lock(hashtext('fl_st:' || new.workspace_id::text));
  new.num := coalesce((select max(num) from fl_stocktakes where workspace_id = new.workspace_id), 0) + 1;
  return new;
end
$$;
create trigger fl_stocktakes_before before insert on fl_stocktakes
  for each row execute function fl_stocktakes_before();

-- Начать: снимок остатков по выбранным компонентам (все / категория / место хранения).
create function fl_stocktake_start(
  p_ws uuid, p_category uuid default null, p_location text default null, p_title text default ''
) returns uuid
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  v_id uuid;
  v_n int;
begin
  if auth.uid() is not null and not ws_is_member(p_ws) then raise exception 'нет доступа'; end if;
  insert into fl_stocktakes (workspace_id, title, created_by)
  values (p_ws, left(coalesce(p_title, ''), 120), auth.uid())
  returning id into v_id;
  insert into fl_stocktake_lines (stocktake_id, component_id, name, sku, unit, location, expected)
  select v_id, c.id, c.name, c.sku, c.unit, c.location, c.stock
    from fl_components c
   where c.workspace_id = p_ws and c.archived_at is null and c.status <> 'obsolete'
     and (p_category is null or c.category_id = p_category)
     and (nullif(trim(coalesce(p_location, '')), '') is null or c.location ilike '%' || trim(p_location) || '%')
   order by c.location nulls last, c.name
   limit 2000;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'по этим условиям нет ни одного компонента'; end if;
  return v_id;
end
$$;

-- Применить: остаток каждого посчитанного компонента становится равным пересчёту.
-- Сравнение — с остатком «сейчас», а не на начало (пока считали, могли что-то списать).
create function fl_stocktake_apply(p_id uuid) returns jsonb
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  s fl_stocktakes;
  r record;
  v_stock numeric;
  v_changed int := 0;
  v_same int := 0;
  v_moved int := 0;
begin
  select * into s from fl_stocktakes where id = p_id for update;
  if s.id is null then raise exception 'инвентаризация не найдена'; end if;
  if auth.uid() is not null and not ws_is_member(s.workspace_id) then raise exception 'нет доступа'; end if;
  if s.status <> 'draft' then raise exception 'инвентаризация уже закрыта'; end if;

  perform set_config('fl.reason', 'Инвентаризация №' || s.num, true);
  for r in select * from fl_stocktake_lines where stocktake_id = p_id and counted is not null order by name loop
    select stock into v_stock from fl_components where id = r.component_id for update;
    if v_stock is null then continue; end if; -- компонент удалили за это время
    if r.expected is distinct from v_stock then v_moved := v_moved + 1; end if;
    if r.counted is distinct from v_stock then
      update fl_components set stock = r.counted where id = r.component_id;
      update fl_stocktake_lines set applied_delta = r.counted - v_stock where id = r.id;
      v_changed := v_changed + 1;
    else
      update fl_stocktake_lines set applied_delta = 0 where id = r.id;
      v_same := v_same + 1;
    end if;
  end loop;
  perform set_config('fl.reason', '', true);

  update fl_stocktakes set status = 'applied', applied_at = now(), applied_by = auth.uid() where id = p_id;
  perform ws_log(s.workspace_id, null, 'stocktake', p_id, 'stocktake.applied',
                 jsonb_build_object('title', 'Инвентаризация №' || s.num, 'to', v_changed::text, 'from', (v_changed + v_same)::text));
  return jsonb_build_object('changed', v_changed, 'same', v_same, 'moved', v_moved);
end
$$;

-- ── права ───────────────────────────────────────────────────────────────────
alter table fl_stocktakes enable row level security;
alter table fl_stocktake_lines enable row level security;

create policy "инвентаризации видят участники" on fl_stocktakes
  for select to authenticated using (ws_is_member(workspace_id));
-- удалить можно только не применённую: применённая — документ истории
create policy "черновик и отменённую удаляют участники" on fl_stocktakes
  for delete to authenticated using (ws_is_member(workspace_id) and status <> 'applied');
create policy "отменить может участник" on fl_stocktakes
  for update to authenticated using (ws_is_member(workspace_id) and status = 'draft')
  with check (ws_is_member(workspace_id) and status in ('draft', 'cancelled'));

create policy "строки видят участники" on fl_stocktake_lines
  for select to authenticated using (exists (select 1 from fl_stocktakes s where s.id = stocktake_id and ws_is_member(s.workspace_id)));
create policy "пересчёт вносят участники, пока черновик" on fl_stocktake_lines
  for update to authenticated
  using (exists (select 1 from fl_stocktakes s where s.id = stocktake_id and ws_is_member(s.workspace_id) and s.status = 'draft'))
  with check (exists (select 1 from fl_stocktakes s where s.id = stocktake_id and ws_is_member(s.workspace_id) and s.status = 'draft'));

revoke all on fl_stocktakes, fl_stocktake_lines from anon, authenticated;
grant select, delete on fl_stocktakes to authenticated;
grant update (status) on fl_stocktakes to authenticated;
grant select on fl_stocktake_lines to authenticated;
grant update (counted) on fl_stocktake_lines to authenticated;

revoke execute on function fl_stocktake_start, fl_stocktake_apply, fl_stocktakes_before from public, anon;
grant execute on function fl_stocktake_start, fl_stocktake_apply to authenticated;

-- ═══ 0020_bot_task_actions.sql ═══
-- Бот: взять задачу, отказаться от неё, оставить комментарий. Всё от имени участника,
-- через те же функции и триггеры, что и на сайте (ws_claim_task, комментарии с уведомлениями).

create function fl_bot_task_action(p_member uuid, p_intent jsonb) returns jsonb
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  m ws_members;
  k text := p_intent ->> 'intent';
  v_task ws_tasks;
begin
  select * into m from ws_members where id = p_member and status = 'active';
  if m.id is null then raise exception 'участник не найден'; end if;
  select * into v_task from ws_tasks
   where workspace_id = m.workspace_id and num = (p_intent ->> 'task_num')::int;
  if v_task.id is null then raise exception 'задача #% не найдена', p_intent ->> 'task_num'; end if;
  perform fl_bot_act_as(m.user_id);

  if k = 'claim_task' then
    perform ws_claim_task(v_task.id);
  elsif k = 'release_task' then
    perform ws_release_task(v_task.id);
  elsif k = 'add_comment' then
    if length(trim(coalesce(p_intent ->> 'text', ''))) = 0 then raise exception 'пустой комментарий'; end if;
    insert into ws_comments (workspace_id, task_id, body)
    values (m.workspace_id, v_task.id, left(trim(p_intent ->> 'text'), 4000));
  else
    raise exception 'неизвестное действие';
  end if;
  return jsonb_build_object('id', v_task.id, 'num', v_task.num, 'title', v_task.title, 'link', '/tasks/' || v_task.id);
end
$$;

revoke all on function fl_bot_task_action from public, anon, authenticated;
grant execute on function fl_bot_task_action to service_role;

-- ═══ 0021_reservations.sql ═══
-- Резерв компонентов под запланированную сборку: «на складе 40, в резерве 30, доступно 10».
-- Резерв ничего не блокирует, он показывает, что запас уже обещан. Когда сборка сделана,
-- резерв этого изделия уменьшается на собранное количество автоматически.

create table fl_reservations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  product_id    uuid references fl_products(id) on delete cascade,
  assembly_id   uuid references fl_assemblies(id) on delete cascade,
  title         text not null,
  units         numeric(14, 3) not null check (units > 0),
  note          text not null default '',
  status        text not null default 'active' check (status in ('active', 'released', 'fulfilled')),
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  closed_at     timestamptz,
  check (num_nonnulls(product_id, assembly_id) = 1)
);
create index fl_reservations_ws_idx on fl_reservations (workspace_id, status, created_at desc);

create table fl_reservation_lines (
  reservation_id uuid not null references fl_reservations(id) on delete cascade,
  component_id   uuid not null references fl_components(id) on delete cascade,
  qty            numeric(14, 3) not null check (qty > 0),
  primary key (reservation_id, component_id)
);
create index fl_reservation_lines_comp_idx on fl_reservation_lines (component_id);

-- Сколько компонента сейчас в активных резервах.
create view fl_component_reserved with (security_invoker = on) as
  select l.component_id, sum(l.qty) as reserved
    from fl_reservation_lines l join fl_reservations r on r.id = l.reservation_id
   where r.status = 'active'
   group by l.component_id;

create function fl_reserve(p_product uuid, p_assembly uuid, p_units numeric, p_note text default '') returns uuid
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  v_ws uuid;
  v_title text;
  v_id uuid;
begin
  if num_nonnulls(p_product, p_assembly) <> 1 then raise exception 'укажите изделие или узел'; end if;
  if p_units is null or p_units <= 0 then raise exception 'количество должно быть больше нуля'; end if;
  if p_product is not null then
    select workspace_id, name || coalesce(' ' || version, '') into v_ws, v_title from fl_products where id = p_product;
  else
    select workspace_id, name into v_ws, v_title from fl_assemblies where id = p_assembly;
  end if;
  if v_ws is null then raise exception 'изделие или узел не найдены'; end if;
  if auth.uid() is not null and not ws_is_member(v_ws) then raise exception 'нет доступа'; end if;
  if not exists (select 1 from fl_explode(p_product, p_assembly, p_units)) then raise exception 'состав пуст — нечего резервировать'; end if;

  insert into fl_reservations (workspace_id, product_id, assembly_id, title, units, note)
  values (v_ws, p_product, p_assembly, v_title, p_units, coalesce(p_note, ''))
  returning id into v_id;
  insert into fl_reservation_lines (reservation_id, component_id, qty)
  select v_id, e.component_id, e.qty from fl_explode(p_product, p_assembly, p_units) e where e.qty > 0;

  perform ws_log(v_ws, null, case when p_product is not null then 'product' else 'assembly' end,
                 coalesce(p_product, p_assembly), 'reservation.created',
                 jsonb_build_object('title', v_title, 'to', trim(to_char(p_units, 'FM999999990.###'))));
  return v_id;
end
$$;

create function fl_reservation_release(p_id uuid) returns void
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare r fl_reservations;
begin
  select * into r from fl_reservations where id = p_id for update;
  if r.id is null then raise exception 'резерв не найден'; end if;
  if auth.uid() is not null and not ws_is_member(r.workspace_id) then raise exception 'нет доступа'; end if;
  if r.status <> 'active' then raise exception 'резерв уже закрыт'; end if;
  update fl_reservations set status = 'released', closed_at = now() where id = p_id;
  perform ws_log(r.workspace_id, null, case when r.product_id is not null then 'product' else 'assembly' end,
                 coalesce(r.product_id, r.assembly_id), 'reservation.released',
                 jsonb_build_object('title', r.title, 'to', trim(to_char(r.units, 'FM999999990.###'))));
end
$$;

-- Собрали N штук — резерв этого изделия (узла) тает на N, старые резервы раньше.
create function fl_reservations_consume() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  r record;
  v_left numeric := new.qty;
  v_take numeric;
begin
  for r in select * from fl_reservations
            where status = 'active' and workspace_id = new.workspace_id
              and product_id is not distinct from new.product_id and assembly_id is not distinct from new.assembly_id
            order by created_at
            for update loop
    exit when v_left <= 0;
    v_take := least(r.units, v_left);
    v_left := v_left - v_take;
    if v_take >= r.units then
      update fl_reservations set status = 'fulfilled', closed_at = now() where id = r.id;
    else
      -- строки, округлённые до нуля, убираем (qty > 0 по проверке), остальные пропорционально уменьшаем
      delete from fl_reservation_lines where reservation_id = r.id and round(qty * (r.units - v_take) / r.units, 3) <= 0;
      update fl_reservation_lines set qty = round(qty * (r.units - v_take) / r.units, 3) where reservation_id = r.id;
      update fl_reservations set units = r.units - v_take where id = r.id;
    end if;
  end loop;
  return new;
end
$$;
create trigger fl_reservations_consume after insert on fl_builds
  for each row execute function fl_reservations_consume();

-- ── права ───────────────────────────────────────────────────────────────────
alter table fl_reservations enable row level security;
alter table fl_reservation_lines enable row level security;
create policy "резервы видят участники" on fl_reservations for select to authenticated using (ws_is_member(workspace_id));
create policy "строки резерва видят участники" on fl_reservation_lines for select to authenticated
  using (exists (select 1 from fl_reservations r where r.id = reservation_id and ws_is_member(r.workspace_id)));
revoke all on fl_reservations, fl_reservation_lines, fl_component_reserved from anon, authenticated;
grant select on fl_reservations, fl_reservation_lines, fl_component_reserved to authenticated;
revoke execute on function fl_reserve, fl_reservation_release, fl_reservations_consume from public, anon;
grant execute on function fl_reserve, fl_reservation_release to authenticated;

alter publication supabase_realtime add table fl_reservations;

-- ═══ 0022_units.sql ═══
-- Серийные номера и прослеживаемость: какой экземпляр когда и из чего собран,
-- как испытан (по серийному номеру в протоколах) и кому отгружен.

create table fl_units (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  product_id    uuid not null references fl_products(id) on delete cascade,
  serial        text not null check (length(trim(serial)) between 1 and 60),
  build_id      uuid references fl_builds(id) on delete set null,
  status        text not null default 'in_stock' check (status in ('in_stock', 'shipped', 'scrap')),
  customer      text not null default '' check (length(customer) <= 200),
  shipped_on    date,
  note          text not null default '' check (length(note) <= 1000),
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index fl_units_serial_uq on fl_units (workspace_id, product_id, lower(trim(serial)));
create index fl_units_ws_idx on fl_units (workspace_id, created_at desc);
create index fl_units_build_idx on fl_units (build_id);
create index fl_units_serial_search_idx on fl_units (workspace_id, lower(serial) text_pattern_ops);

create function fl_units_before() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if tg_op = 'INSERT' then
    select workspace_id into new.workspace_id from fl_products where id = new.product_id;
    if new.workspace_id is null then raise exception 'изделие не найдено'; end if;
    if auth.uid() is not null and not ws_is_member(new.workspace_id) then raise exception 'нет доступа'; end if;
    new.serial := trim(new.serial);
  else
    new.updated_at := now();
    if new.status = 'shipped' and new.shipped_on is null then new.shipped_on := current_date; end if;
    if new.status <> 'shipped' and old.status = 'shipped' then new.shipped_on := null; end if;
  end if;
  return new;
end
$$;
create trigger fl_units_before before insert or update on fl_units
  for each row execute function fl_units_before();

create function fl_units_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare v_title text;
begin
  select name || coalesce(' ' || version, '') into v_title from fl_products where id = new.product_id;
  if new.status is distinct from old.status then
    perform ws_log(new.workspace_id, null, 'product', new.product_id,
                   case new.status when 'shipped' then 'unit.shipped' when 'scrap' then 'unit.scrapped' else 'unit.restored' end,
                   jsonb_build_object('title', v_title, 'serial', new.serial, 'to', nullif(new.customer, '')));
  end if;
  return new;
end
$$;
create trigger fl_units_log after update on fl_units
  for each row execute function fl_units_log();

-- Сборка с серийными номерами одной операцией: либо и списание, и номера, либо ничего.
create function fl_build_serial(p_product uuid, p_qty numeric, p_note text, p_serials text[]) returns uuid
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  v_id uuid;
  v_serials text[];
  v_dup text;
begin
  select coalesce(array_agg(trim(s)), '{}') into v_serials from unnest(coalesce(p_serials, '{}')) s where length(trim(s)) > 0;
  if cardinality(v_serials) > 0 then
    if p_qty <> floor(p_qty) then raise exception 'с серийными номерами количество должно быть целым'; end if;
    if cardinality(v_serials) <> p_qty then
      raise exception 'номеров %, а собрано % шт — количество должно совпадать', cardinality(v_serials), trim(to_char(p_qty, 'FM999999990.###'));
    end if;
    select lower(s) into v_dup from unnest(v_serials) s group by lower(s) having count(*) > 1 limit 1;
    if v_dup is not null then raise exception 'номер % повторяется в списке', v_dup; end if;
    select u.serial into v_dup from fl_units u
     where u.product_id = p_product and lower(trim(u.serial)) = any (select lower(s) from unnest(v_serials) s) limit 1;
    if v_dup is not null then raise exception 'номер % уже есть у этого изделия', v_dup; end if;
  end if;

  v_id := fl_build(p_product, null, p_qty, p_note);
  insert into fl_units (product_id, serial, build_id, created_by)
  select p_product, s, v_id, auth.uid() from unnest(v_serials) s;
  return v_id;
end
$$;

-- Отменить сборку можно, пока её экземпляры на складе: отгруженное или списанное отменой не вернуть.
create function fl_builds_units_guard() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if old.reverted_at is null and new.reverted_at is not null then
    if exists (select 1 from fl_units where build_id = new.id and status <> 'in_stock') then
      raise exception 'сборку не отменить: часть её экземпляров уже отгружена или списана в брак';
    end if;
    delete from fl_units where build_id = new.id;
  end if;
  return new;
end
$$;
create trigger fl_builds_units_guard before update on fl_builds
  for each row execute function fl_builds_units_guard();

-- ── права ───────────────────────────────────────────────────────────────────
alter table fl_units enable row level security;
create policy "экземпляры видят участники" on fl_units for select to authenticated using (ws_is_member(workspace_id));
create policy "экземпляры добавляют участники" on fl_units for insert to authenticated with check (ws_is_member(workspace_id));
create policy "экземпляры правят участники" on fl_units for update to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));
-- удалить можно только то, что лежит на складе (ошибочно заведённый номер)
create policy "экземпляр на складе удаляют участники" on fl_units for delete to authenticated using (ws_is_member(workspace_id) and status = 'in_stock');

revoke all on fl_units from anon, authenticated;
grant select, delete on fl_units to authenticated;
grant insert (product_id, serial, note) on fl_units to authenticated;
grant update (status, customer, shipped_on, note) on fl_units to authenticated;
revoke execute on function fl_build_serial, fl_units_before, fl_units_log, fl_builds_units_guard from public, anon;
grant execute on function fl_build_serial to authenticated;

alter publication supabase_realtime add table fl_units;

-- ═══ 0023_customer_orders.sql ═══
-- Заказы клиентов: кто что заказал, на какую сумму, оплачено ли, что уже отгружено.
-- Даёт фактическую выручку и маржу (по расчётной себестоимости), а не только плановую.

create table fl_customer_orders (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  num           int not null,
  customer      text not null check (length(trim(customer)) between 1 and 200),
  contact       text not null default '' check (length(contact) <= 300),
  status        text not null default 'new' check (status in ('new', 'in_progress', 'ready', 'shipped', 'cancelled')),
  currency      text not null default 'RUB' check (currency in ('RUB', 'USD', 'CNY', 'EUR')),
  due_on        date,
  note          text not null default '' check (length(note) <= 2000),
  paid          numeric(14, 2) not null default 0 check (paid >= 0),
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, num)
);
create index fl_customer_orders_ws_idx on fl_customer_orders (workspace_id, created_at desc);

create table fl_customer_order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references fl_customer_orders(id) on delete cascade,
  product_id  uuid references fl_products(id) on delete set null,
  -- название на момент заказа: изделие могут потом переименовать или удалить
  name        text not null,
  qty         numeric(14, 3) not null check (qty > 0),
  price       numeric(14, 2) not null default 0 check (price >= 0),
  position    int not null default 0
);
create index fl_customer_order_items_idx on fl_customer_order_items (order_id);

-- Экземпляр можно привязать к заказу, по которому он отгружен.
alter table fl_units add column order_id uuid references fl_customer_orders(id) on delete set null;
create index fl_units_order_idx on fl_units (order_id);

create function fl_customer_orders_before() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtext('fl_co:' || new.workspace_id::text));
    new.num := coalesce((select max(num) from fl_customer_orders where workspace_id = new.workspace_id), 0) + 1;
    new.customer := trim(new.customer);
  else
    new.updated_at := now();
  end if;
  return new;
end
$$;
create trigger fl_customer_orders_before before insert or update on fl_customer_orders
  for each row execute function fl_customer_orders_before();

create function fl_customer_orders_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if tg_op = 'INSERT' then
    perform ws_log(new.workspace_id, null, 'sale', new.id, 'sale.created',
                   jsonb_build_object('title', 'Заказ клиента №' || new.num, 'to', new.customer));
  elsif new.status is distinct from old.status then
    perform ws_log(new.workspace_id, null, 'sale', new.id, 'sale.status',
                   jsonb_build_object('title', 'Заказ клиента №' || new.num, 'from', old.status, 'to', new.status));
  end if;
  return new;
end
$$;
create trigger fl_customer_orders_log after insert or update on fl_customer_orders
  for each row execute function fl_customer_orders_log();

-- Создать заказ с позициями: [{product_id, qty, price?}]. Цена по умолчанию — из карточки
-- изделия (фактическая, иначе плановая), если она в валюте заказа; иначе 0 — впишут руками.
create function fl_co_create(
  p_ws uuid, p_customer text, p_contact text, p_currency text, p_due date, p_note text, p_items jsonb
) returns uuid
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  v_id uuid;
  it jsonb;
  pr fl_products;
  v_pos int := 0;
  v_price numeric;
begin
  if auth.uid() is not null and not ws_is_member(p_ws) then raise exception 'нет доступа'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'добавьте хотя бы одну позицию'; end if;
  insert into fl_customer_orders (workspace_id, customer, contact, currency, due_on, note)
  values (p_ws, p_customer, coalesce(p_contact, ''), coalesce(p_currency, 'RUB'), p_due, coalesce(p_note, ''))
  returning id into v_id;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into pr from fl_products where id = (it ->> 'product_id')::uuid and workspace_id = p_ws;
    if pr.id is null then raise exception 'изделие не найдено'; end if;
    v_price := coalesce((it ->> 'price')::numeric,
                        case when pr.price_currency = coalesce(p_currency, 'RUB') then coalesce(pr.actual_price, pr.planned_price) end, 0);
    insert into fl_customer_order_items (order_id, product_id, name, qty, price, position)
    values (v_id, pr.id, pr.name || coalesce(' ' || pr.version, ''), (it ->> 'qty')::numeric, v_price, v_pos);
    v_pos := v_pos + 1;
  end loop;
  return v_id;
end
$$;

-- ── права ───────────────────────────────────────────────────────────────────
alter table fl_customer_orders enable row level security;
alter table fl_customer_order_items enable row level security;

create policy "заказы клиентов видят участники" on fl_customer_orders for select to authenticated using (ws_is_member(workspace_id));
create policy "заказы клиентов правят участники" on fl_customer_orders for update to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));
-- удалить можно новый или отменённый: остальные — история продаж
create policy "новый или отменённый заказ удаляют участники" on fl_customer_orders for delete to authenticated
  using (ws_is_member(workspace_id) and status in ('new', 'cancelled'));

create policy "позиции заказов видят участники" on fl_customer_order_items for select to authenticated
  using (exists (select 1 from fl_customer_orders o where o.id = order_id and ws_is_member(o.workspace_id)));
-- позиции меняются, пока заказ новый: потом — только через отмену и новый заказ
create policy "позиции нового заказа правят участники" on fl_customer_order_items for all to authenticated
  using (exists (select 1 from fl_customer_orders o where o.id = order_id and ws_is_member(o.workspace_id) and o.status = 'new'))
  with check (exists (select 1 from fl_customer_orders o where o.id = order_id and ws_is_member(o.workspace_id) and o.status = 'new'));

revoke all on fl_customer_orders, fl_customer_order_items from anon, authenticated;
grant select, delete on fl_customer_orders to authenticated;
grant update (customer, contact, status, currency, due_on, note, paid) on fl_customer_orders to authenticated;
grant select, delete on fl_customer_order_items to authenticated;
grant insert (order_id, product_id, name, qty, price, position) on fl_customer_order_items to authenticated;
grant update (qty, price) on fl_customer_order_items to authenticated;
grant update (order_id) on fl_units to authenticated;
revoke execute on function fl_co_create, fl_customer_orders_before, fl_customer_orders_log from public, anon;
grant execute on function fl_co_create to authenticated;

alter publication supabase_realtime add table fl_customer_orders, fl_customer_order_items;

-- ═══ 0024_viewer_role.sql ═══
-- Роль «наблюдатель» (viewer): видит всё в контуре, но ничего не меняет. Для заказчика,
-- подрядчика, бухгалтера, которым нужен статус, а не правка.
--
-- Защита держится на триггерах, а не на политиках: триггер срабатывает и на прямые записи
-- из браузера, и на записи внутри функций с правами владельца (сборка, заказы, бот от имени
-- пользователя) — в обоих случаях auth.uid() остаётся вошедшим человеком.

alter table ws_members drop constraint ws_members_role_check;
alter table ws_members add constraint ws_members_role_check check (role in ('owner', 'admin', 'member', 'viewer'));
alter table ws_invitations drop constraint ws_invitations_role_check;
alter table ws_invitations add constraint ws_invitations_role_check check (role in ('admin', 'member', 'viewer'));

create function ws_is_viewer(p_ws uuid) returns boolean
language sql stable security definer
set search_path = public
set row_security = off
as $$
  select exists (select 1 from ws_members where workspace_id = p_ws and user_id = auth.uid() and status = 'active' and role = 'viewer')
$$;

-- Приглашать можно и наблюдателя (только owner и admin, как и остальных).
create or replace function ws_invite_member(
  p_ws uuid, p_name text, p_email text, p_role text, p_message text default null
) returns text
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  v_member ws_members;
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not ws_is_admin(p_ws) then raise exception 'приглашать могут owner и admin'; end if;
  if p_role not in ('admin', 'member', 'viewer') then raise exception 'роль: admin, member или viewer'; end if;
  if p_role = 'admin' and ws_role(p_ws) <> 'owner' then
    raise exception 'администраторов приглашает только owner';
  end if;
  if position('@' in p_email) < 2 then raise exception 'некорректный email'; end if;
  if exists (select 1 from ws_members where workspace_id = p_ws and lower(email) = lower(p_email)) then
    raise exception 'участник с таким email уже есть';
  end if;

  insert into ws_members (workspace_id, email, name, role, status, invited_by)
  values (p_ws, trim(p_email), trim(p_name), p_role, 'invited', auth.uid())
  returning * into v_member;

  insert into ws_invitations (workspace_id, member_id, email, role, message, token_hash, invited_by)
  values (p_ws, v_member.id, v_member.email, p_role, nullif(trim(p_message), ''),
          sha256(convert_to(v_token, 'utf8')), auth.uid());

  perform ws_log(p_ws, null, 'member', v_member.id, 'member.invited',
                 jsonb_build_object('name', v_member.name, 'role', p_role));
  return v_token;
end
$$;

-- ── защита от записи ────────────────────────────────────────────────────────
-- TG_ARGV[0] — таблица-родитель ('' — workspace_id в самой строке), TG_ARGV[1] — колонка связи.
create function fl_viewer_guard() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  j jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_ws uuid;
begin
  if auth.uid() is null then return case when tg_op = 'DELETE' then old else new end; end if; -- сервис и cron
  if coalesce(tg_argv[0], '') = '' then
    v_ws := (j ->> coalesce(nullif(tg_argv[1], ''), 'workspace_id'))::uuid;
  else
    execute format('select workspace_id from %I where id = $1', tg_argv[0]) into v_ws using (j ->> tg_argv[1])::uuid;
  end if;
  if v_ws is not null and ws_is_viewer(v_ws) then
    raise exception 'наблюдатель не может менять данные';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

do $$
declare
  t text;
  -- таблицы, где контур определяется через родителя
  via constant jsonb := '{
    "fl_customer_order_items": ["fl_customer_orders", "order_id"],
    "fl_purchase_order_items": ["fl_purchase_orders", "order_id"],
    "fl_stocktake_lines": ["fl_stocktakes", "stocktake_id"],
    "fl_reservation_lines": ["fl_reservations", "reservation_id"],
    "ws_task_labels": ["ws_tasks", "task_id"],
    "ws_task_watchers": ["ws_tasks", "task_id"]
  }';
  -- личные данные и служебные журналы: наблюдатель их менять может (свой профиль, прочитано, привязка Telegram)
  skip constant text[] := array['ws_members', 'ws_activity', 'ws_notifications', 'ws_invitations',
                                'fl_notify_prefs', 'fl_tg_links', 'fl_tg_link_codes', 'fl_tg_pending', 'fl_outbox', 'fl_rates',
                                'ws_conversation_members'];
begin
  -- всё, что лежит в контуре
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'workspace_id')
              and c.relname <> all (skip)
  loop
    execute format('create trigger zzz_viewer_guard before insert or update or delete on %I for each row execute function fl_viewer_guard()', t);
  end loop;
  -- через родителя
  for t in select k from jsonb_object_keys(via) k loop
    execute format('create trigger zzz_viewer_guard before insert or update or delete on %I for each row execute function fl_viewer_guard(%L, %L)',
                   t, via -> t ->> 0, via -> t ->> 1);
  end loop;
end
$$;

-- сам контур (месячный бюджет): контур определяется по id
create trigger zzz_viewer_guard before update on ws_workspaces
  for each row execute function fl_viewer_guard('', 'id');
-- состав чата меняется через функции; чтение (last_read) остаётся доступным
create trigger zzz_viewer_guard before insert or delete on ws_conversation_members
  for each row execute function fl_viewer_guard('ws_conversations', 'conversation_id');

-- файлы в хранилище: загрузка и удаление в бакете контура — не для наблюдателя
create policy "наблюдатель не пишет файлы" on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id <> 'ws-files' or not ws_is_viewer(ws_storage_ws(name)));
create policy "наблюдатель не правит файлы" on storage.objects
  as restrictive for update to authenticated
  using (bucket_id <> 'ws-files' or not ws_is_viewer(ws_storage_ws(name)));
create policy "наблюдатель не удаляет файлы" on storage.objects
  as restrictive for delete to authenticated
  using (bucket_id <> 'ws-files' or not ws_is_viewer(ws_storage_ws(name)));

revoke execute on function fl_viewer_guard, ws_is_viewer from public, anon;
grant execute on function ws_is_viewer to authenticated, service_role;

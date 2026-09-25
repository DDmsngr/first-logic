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

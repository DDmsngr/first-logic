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

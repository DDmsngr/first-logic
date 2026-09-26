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

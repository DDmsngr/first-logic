-- Качество: протоколы испытаний изделий и ревизии состава (BOM).

-- ── испытания ───────────────────────────────────────────────────────────────
-- У изделия — шаблон измерений с допусками; у каждого испытания — значения.
-- Итог (годен / брак / не закончено) считает база по допускам.

alter table fl_products add column test_params jsonb not null default '[]'::jsonb
  check (jsonb_typeof(test_params) = 'array');

create table fl_tests (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  product_id    uuid not null references fl_products(id) on delete cascade,
  serial        text,                                -- серийный номер или партия
  tested_on     date not null default current_date,
  tester_id     uuid references auth.users(id) on delete set null default auth.uid(),
  -- [{name, unit, min, max, value}] — min/max могут быть null (без границы)
  measurements  jsonb not null default '[]'::jsonb check (jsonb_typeof(measurements) = 'array'),
  result        text not null default 'pending' check (result in ('pass', 'fail', 'pending')),
  note          text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index fl_tests_product_idx on fl_tests (product_id, tested_on desc);
create index fl_tests_serial_idx on fl_tests (workspace_id, lower(serial));

-- Годен: все значения есть и в допуске. Брак: хоть одно вне допуска.
-- Не закончено: чего-то не хватает, а брака пока нет.
create function fl_test_result(p_m jsonb) returns text
language sql immutable
as $$
  select case
    when exists (select 1 from jsonb_array_elements(p_m) m
                  where jsonb_typeof(m -> 'value') = 'number'
                    and ((jsonb_typeof(m -> 'min') = 'number' and (m ->> 'value')::numeric < (m ->> 'min')::numeric)
                      or (jsonb_typeof(m -> 'max') = 'number' and (m ->> 'value')::numeric > (m ->> 'max')::numeric)))
      then 'fail'
    when jsonb_array_length(p_m) = 0
      or exists (select 1 from jsonb_array_elements(p_m) m where jsonb_typeof(m -> 'value') <> 'number')
      then 'pending'
    else 'pass'
  end
$$;

create function fl_tests_before() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.workspace_id := (select workspace_id from fl_products where id = new.product_id);
  if new.workspace_id is null then raise exception 'изделие не найдено'; end if;
  new.result := fl_test_result(new.measurements);
  new.updated_at := now();
  return new;
end
$$;
create trigger fl_tests_before before insert or update on fl_tests
  for each row execute function fl_tests_before();

create function fl_tests_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if tg_op = 'UPDATE' and new.result is not distinct from old.result then return new; end if;
  perform ws_log(new.workspace_id, null, 'product', new.product_id, 'test.' || new.result,
                 jsonb_build_object('title', (select name from fl_products where id = new.product_id), 'serial', new.serial));
  if new.result = 'fail' then
    perform fl_outbox_broadcast(new.workspace_id, 'test',
      '🔴 Брак на испытаниях: «' || (select name from fl_products where id = new.product_id) || '»'
        || coalesce(', № ' || new.serial, ''),
      '/products/' || new.product_id, 'test:' || new.id);
  end if;
  return new;
end
$$;
create trigger fl_tests_log after insert or update of measurements on fl_tests
  for each row execute function fl_tests_log();

alter table fl_notify_prefs drop constraint fl_notify_prefs_kind_check;
alter table fl_notify_prefs add constraint fl_notify_prefs_kind_check
  check (kind in ('task', 'comment', 'overdue', 'low_stock', 'price', 'product_status', 'budget', 'expense', 'order', 'digest', 'test'));

-- ── ревизии состава ─────────────────────────────────────────────────────────
-- Снимок состава с ценами на момент фиксации: потом видно, что изменилось
-- и во что обходилась старая версия. Снимок собирает клиент (расчёт — costing.ts).

create table fl_bom_revisions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  product_id    uuid references fl_products(id) on delete cascade,
  assembly_id   uuid references fl_assemblies(id) on delete cascade,
  label         text not null check (length(trim(label)) between 1 and 60),
  note          text not null default '',
  -- [{kind, ref_id, name, qty, unit, unit_rub, total_rub}]
  lines         jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  total_rub     numeric(16, 2) not null default 0,
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  check (num_nonnulls(product_id, assembly_id) = 1)
);
create index fl_bom_revisions_product_idx on fl_bom_revisions (product_id, created_at desc);
create index fl_bom_revisions_assembly_idx on fl_bom_revisions (assembly_id, created_at desc);

create function fl_bom_revisions_before() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.workspace_id := coalesce((select workspace_id from fl_products where id = new.product_id),
                               (select workspace_id from fl_assemblies where id = new.assembly_id));
  if new.workspace_id is null then raise exception 'изделие или узел не найдены'; end if;
  return new;
end
$$;
create trigger fl_bom_revisions_before before insert on fl_bom_revisions
  for each row execute function fl_bom_revisions_before();

create function fl_bom_revisions_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  perform ws_log(new.workspace_id, null, case when new.product_id is not null then 'product' else 'assembly' end,
                 coalesce(new.product_id, new.assembly_id), 'bom.revision',
                 jsonb_build_object('title', coalesce((select name from fl_products where id = new.product_id),
                                                      (select name from fl_assemblies where id = new.assembly_id)),
                                    'to', new.label));
  return new;
end
$$;
create trigger fl_bom_revisions_log after insert on fl_bom_revisions
  for each row execute function fl_bom_revisions_log();

-- ── RLS и права ─────────────────────────────────────────────────────────────

alter table fl_tests         enable row level security;
alter table fl_bom_revisions enable row level security;
create policy "испытания: участники" on fl_tests
  for all to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));
create policy "ревизии видят участники" on fl_bom_revisions
  for select to authenticated using (ws_is_member(workspace_id));
create policy "ревизии создают участники" on fl_bom_revisions
  for insert to authenticated with check (ws_is_member(workspace_id));
create policy "ревизии удаляют участники" on fl_bom_revisions
  for delete to authenticated using (ws_is_member(workspace_id));
create policy "подпись ревизии правят участники" on fl_bom_revisions
  for update to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));

revoke all on fl_tests, fl_bom_revisions from anon, authenticated;
grant select, insert, update, delete on fl_tests to authenticated;
grant select, insert, delete on fl_bom_revisions to authenticated;
-- снимок неизменен, поправить можно только подпись и примечание
grant update (label, note) on fl_bom_revisions to authenticated;
grant execute on function fl_test_result to authenticated;

alter publication supabase_realtime add table fl_tests, fl_bom_revisions;

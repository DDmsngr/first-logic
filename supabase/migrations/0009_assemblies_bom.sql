-- Узлы и BOM (состав изделий и узлов).
--
-- Одна строка BOM: родитель (изделие или узел) содержит потомка (компонент
-- или узел) в количестве qty. Стоимость считает клиент (src/costing.ts) по
-- текущим ценам и курсам — в базе хранятся только количества и ручные цены.

-- ── узлы ────────────────────────────────────────────────────────────────────

create table fl_assemblies (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references ws_workspaces(id) on delete cascade,
  name           text not null check (length(trim(name)) between 1 and 200),
  sku            text,
  description    text not null default '',
  -- ручная себестоимость узла в рублях (покупной модуль, уточнённая оценка);
  -- если задана — перекрывает расчёт по составу, оба значения видны в UI
  cost_override  numeric(14, 2) check (cost_override is null or cost_override >= 0),
  notes          text not null default '',
  created_by     uuid references auth.users(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz
);
create index fl_assemblies_ws_idx on fl_assemblies (workspace_id, name);

create trigger fl_assemblies_touch before update on fl_assemblies
  for each row execute function fl_touch_updated();

create function fl_assemblies_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if tg_op = 'INSERT' then
    perform ws_log(new.workspace_id, null, 'assembly', new.id, 'assembly.created', jsonb_build_object('title', new.name));
  elsif new.cost_override is distinct from old.cost_override then
    perform ws_log(new.workspace_id, null, 'assembly', new.id, 'assembly.override',
                   jsonb_build_object('title', new.name, 'from', old.cost_override::text, 'to', new.cost_override::text));
  end if;
  return new;
end
$$;
create trigger fl_assemblies_log after insert or update on fl_assemblies
  for each row execute function fl_assemblies_log();

-- ── строки BOM ──────────────────────────────────────────────────────────────

create table fl_bom_items (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references ws_workspaces(id) on delete cascade,
  parent_product_id   uuid references fl_products(id) on delete cascade,
  parent_assembly_id  uuid references fl_assemblies(id) on delete cascade,
  component_id        uuid references fl_components(id) on delete cascade,
  child_assembly_id   uuid references fl_assemblies(id) on delete cascade,
  qty                 numeric(14, 4) not null check (qty > 0),
  -- цена именно в этой строке (другой поставщик, партия); иначе — цена компонента
  price_override      numeric(14, 4) check (price_override is null or price_override >= 0),
  price_currency      text not null default 'RUB' check (price_currency in ('RUB', 'USD', 'CNY', 'EUR')),
  note                text not null default '',
  position            int not null default 0,
  created_at          timestamptz not null default now(),
  check (num_nonnulls(parent_product_id, parent_assembly_id) = 1),
  check (num_nonnulls(component_id, child_assembly_id) = 1),
  check (child_assembly_id is distinct from parent_assembly_id)
);
create unique index fl_bom_items_uq on fl_bom_items (
  coalesce(parent_product_id, parent_assembly_id), coalesce(component_id, child_assembly_id));
create index fl_bom_items_ws_idx on fl_bom_items (workspace_id);
create index fl_bom_items_component_idx on fl_bom_items (component_id);
create index fl_bom_items_child_idx on fl_bom_items (child_assembly_id);

-- Всё из одного workspace; узел не может (через цепочку) содержать сам себя.
create function fl_bom_items_check() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  new.workspace_id := coalesce(
    (select workspace_id from fl_products where id = new.parent_product_id),
    (select workspace_id from fl_assemblies where id = new.parent_assembly_id));
  if new.workspace_id is null then raise exception 'родитель строки BOM не найден'; end if;
  if not exists (select 1 from fl_components where id = new.component_id and workspace_id = new.workspace_id)
     and not exists (select 1 from fl_assemblies where id = new.child_assembly_id and workspace_id = new.workspace_id) then
    raise exception 'компонент или узел не найден';
  end if;
  if new.parent_assembly_id is not null and new.child_assembly_id is not null and exists (
    with recursive down(id) as (
      select new.child_assembly_id
      union
      select b.child_assembly_id from fl_bom_items b join down d on b.parent_assembly_id = d.id
      where b.child_assembly_id is not null and b.id is distinct from new.id
    )
    select 1 from down where id = new.parent_assembly_id
  ) then
    raise exception 'так узел окажется внутри самого себя';
  end if;
  return new;
end
$$;
create trigger fl_bom_items_check before insert or update on fl_bom_items
  for each row execute function fl_bom_items_check();

-- Журнал пишется на родителя: в истории изделия/узла видно, что менялось в составе.
create function fl_bom_items_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  r fl_bom_items := case when tg_op = 'DELETE' then old else new end;
  v_type text := case when r.parent_product_id is not null then 'product' else 'assembly' end;
  v_parent uuid := coalesce(r.parent_product_id, r.parent_assembly_id);
  v_title text := coalesce((select name from fl_products where id = r.parent_product_id),
                           (select name from fl_assemblies where id = r.parent_assembly_id));
  v_child text := coalesce((select name from fl_components where id = r.component_id),
                           (select name from fl_assemblies where id = r.child_assembly_id));
begin
  if v_title is null then return r; end if;  -- родитель удаляется каскадом
  if tg_op = 'INSERT' then
    perform ws_log(r.workspace_id, null, v_type, v_parent, 'bom.added',
                   jsonb_build_object('title', v_title, 'child', v_child, 'to', r.qty::text));
  elsif tg_op = 'DELETE' then
    perform ws_log(r.workspace_id, null, v_type, v_parent, 'bom.removed',
                   jsonb_build_object('title', v_title, 'child', v_child));
  elsif new.qty is distinct from old.qty then
    perform ws_log(r.workspace_id, null, v_type, v_parent, 'bom.qty',
                   jsonb_build_object('title', v_title, 'child', v_child, 'from', old.qty::text, 'to', new.qty::text));
  end if;
  return r;
end
$$;
create trigger fl_bom_items_log after insert or update or delete on fl_bom_items
  for each row execute function fl_bom_items_log();

-- ── файлы узла ──────────────────────────────────────────────────────────────

alter table ws_attachments add column assembly_id uuid references fl_assemblies(id) on delete cascade;
alter table ws_attachments drop constraint ws_attachments_target_check;
alter table ws_attachments add constraint ws_attachments_target_check
  check (num_nonnulls(task_id, message_id, component_id, supplier_id, product_id, assembly_id) = 1);
create index ws_attachments_assembly_idx on ws_attachments (assembly_id);

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
    (select workspace_id from fl_suppliers where id = new.supplier_id),
    (select workspace_id from fl_products where id = new.product_id),
    (select workspace_id from fl_assemblies where id = new.assembly_id)
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
      or (product_id is not null and exists (
            select 1 from fl_products p where p.id = product_id and ws_is_member(p.workspace_id)))
      or (assembly_id is not null and exists (
            select 1 from fl_assemblies a where a.id = assembly_id and ws_is_member(a.workspace_id)))
    )
  );

-- ── поиск: плюс узлы ────────────────────────────────────────────────────────

create or replace function ws_search(p_ws uuid, p_q text) returns jsonb
language plpgsql stable
as $$
declare
  v_like text := '%' || replace(replace(replace(trim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_num  text := ltrim(trim(p_q), '#');
begin
  if length(trim(p_q)) < 2 and v_num !~ '^\d+$' then
    return jsonb_build_object('tasks', '[]'::jsonb, 'members', '[]'::jsonb, 'messages', '[]'::jsonb,
                              'files', '[]'::jsonb, 'components', '[]'::jsonb, 'suppliers', '[]'::jsonb,
                              'products', '[]'::jsonb, 'assemblies', '[]'::jsonb);
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
      select id, task_id, component_id, supplier_id, product_id, assembly_id, filename, size from ws_attachments
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
      order by name limit 8) x), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(x) from (
      select id, name, sku, version from fl_products
      where workspace_id = p_ws and archived_at is null
        and (name ilike v_like or sku ilike v_like or description ilike v_like)
      order by name limit 8) x), '[]'::jsonb),
    'assemblies', coalesce((select jsonb_agg(x) from (
      select id, name, sku from fl_assemblies
      where workspace_id = p_ws and archived_at is null
        and (name ilike v_like or sku ilike v_like or description ilike v_like)
      order by name limit 8) x), '[]'::jsonb)
  );
end
$$;

-- ── RLS и права ─────────────────────────────────────────────────────────────

alter table fl_assemblies enable row level security;
alter table fl_bom_items  enable row level security;
create policy "узлы: участники" on fl_assemblies
  for all to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));
create policy "BOM: участники" on fl_bom_items
  for all to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));

revoke all on fl_assemblies, fl_bom_items from anon, authenticated;
grant select, insert, update, delete on fl_assemblies, fl_bom_items to authenticated;

alter publication supabase_realtime add table fl_assemblies, fl_bom_items;

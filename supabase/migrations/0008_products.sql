-- Фаза «Изделия»: усилители, их статусы, характеристики, цены, связь с задачами.
-- Себестоимость (BOM, производство, маржа) добавится следующими миграциями.

-- ── статусы изделий: редактируемый справочник ───────────────────────────────

insert into fl_dicts (workspace_id, kind, name, color, position)
select w.id, 'product_status', s.name, s.color, s.pos
from ws_workspaces w
cross join (values
  ('Концепт', '#8795a3', 1), ('Разработка', '#5ec4e6', 2), ('Прототип', '#b49cf0', 3),
  ('Испытания', '#f2b94b', 4), ('Производство', '#5fd08f', 5), ('Снято с производства', '#6b7785', 6)
) as s(name, color, pos)
where w.slug = 'first-logic';

-- ── изделия ─────────────────────────────────────────────────────────────────

create table fl_products (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references ws_workspaces(id) on delete cascade,
  name           text not null check (length(trim(name)) between 1 and 200),
  sku            text,                        -- внутренний артикул
  version        text,
  status_id      uuid references fl_dicts(id) on delete set null,
  description    text not null default '',
  -- [{ "name": "Мощность", "value": "100", "unit": "Вт" }, …] в порядке показа
  specs          jsonb not null default '[]'::jsonb check (jsonb_typeof(specs) = 'array'),
  planned_price  numeric(14, 2) check (planned_price is null or planned_price >= 0),
  actual_price   numeric(14, 2) check (actual_price is null or actual_price >= 0),
  price_currency text not null default 'RUB' check (price_currency in ('RUB', 'USD', 'CNY', 'EUR')),
  notes          text not null default '',
  created_by     uuid references auth.users(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz
);
create index fl_products_ws_idx on fl_products (workspace_id, name);
create unique index fl_products_sku_uq on fl_products (workspace_id, lower(sku)) where sku is not null;

create trigger fl_products_touch before update on fl_products
  for each row execute function fl_touch_updated();

create function fl_products_check() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status_id is not null and not exists (
       select 1 from fl_dicts where id = new.status_id
         and workspace_id = new.workspace_id and kind = 'product_status') then
    raise exception 'статус изделия не найден';
  end if;
  return new;
end
$$;
create trigger fl_products_check before insert or update on fl_products
  for each row execute function fl_products_check();

create function fl_products_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  st text := (select name from fl_dicts where id = new.status_id);
begin
  if tg_op = 'INSERT' then
    perform ws_log(new.workspace_id, null, 'product', new.id, 'product.created', jsonb_build_object('title', new.name));
    return new;
  end if;
  if new.status_id is distinct from old.status_id then
    perform ws_log(new.workspace_id, null, 'product', new.id, 'product.status',
                   jsonb_build_object('title', new.name, 'from', (select name from fl_dicts where id = old.status_id), 'to', st));
  end if;
  if (new.planned_price, new.actual_price, new.price_currency)
       is distinct from (old.planned_price, old.actual_price, old.price_currency) then
    perform ws_log(new.workspace_id, null, 'product', new.id, 'product.price',
                   jsonb_build_object('title', new.name,
                                      'from', coalesce(old.actual_price, old.planned_price)::text || ' ' || old.price_currency,
                                      'to', coalesce(new.actual_price, new.planned_price)::text || ' ' || new.price_currency));
  end if;
  if new.archived_at is distinct from old.archived_at then
    perform ws_log(new.workspace_id, null, 'product', new.id,
                   case when new.archived_at is null then 'product.restored' else 'product.archived' end,
                   jsonb_build_object('title', new.name));
  end if;
  return new;
end
$$;
create trigger fl_products_log after insert or update on fl_products
  for each row execute function fl_products_log();

-- ── задача ↔ изделие ────────────────────────────────────────────────────────

alter table ws_tasks add column product_id uuid references fl_products(id) on delete set null;
create index ws_tasks_product_idx on ws_tasks (product_id);

create function ws_tasks_product_check() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if new.product_id is not null and not exists (
       select 1 from fl_products where id = new.product_id and workspace_id = new.workspace_id) then
    raise exception 'изделие не найдено';
  end if;
  return new;
end
$$;
create trigger ws_tasks_product_check before insert or update of product_id on ws_tasks
  for each row execute function ws_tasks_product_check();

-- ── файлы изделия ───────────────────────────────────────────────────────────

alter table ws_attachments add column product_id uuid references fl_products(id) on delete cascade;
alter table ws_attachments drop constraint ws_attachments_target_check;
alter table ws_attachments add constraint ws_attachments_target_check
  check (num_nonnulls(task_id, message_id, component_id, supplier_id, product_id) = 1);
create index ws_attachments_product_idx on ws_attachments (product_id);

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
    (select workspace_id from fl_products where id = new.product_id)
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
    )
  );

-- ── поиск: плюс изделия ─────────────────────────────────────────────────────

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
                              'products', '[]'::jsonb);
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
      select id, task_id, component_id, supplier_id, product_id, filename, size from ws_attachments
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
      order by name limit 8) x), '[]'::jsonb)
  );
end
$$;

-- ── RLS и права ─────────────────────────────────────────────────────────────

alter table fl_products enable row level security;
create policy "изделия: участники" on fl_products
  for all to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));

revoke all on fl_products from anon, authenticated;
grant select, insert, update, delete on fl_products to authenticated;

alter publication supabase_realtime add table fl_products;

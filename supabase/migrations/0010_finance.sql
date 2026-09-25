-- Финансы: расходы и параметры полной себестоимости изделия.
--
-- Формула себестоимости живёт в src/costing.ts (unitEconomics) и показывается
-- в интерфейсе с подставленными числами; здесь только редактируемые параметры.

-- ── категории расходов ──────────────────────────────────────────────────────

insert into fl_dicts (workspace_id, kind, name, color, position)
select w.id, 'expense_category', c.name, c.color, c.pos
from ws_workspaces w
cross join (values
  ('Компоненты', '#5ec4e6', 1), ('Производство', '#5fd08f', 2), ('Доставка', '#f2b94b', 3),
  ('Инструмент', '#e0a458', 4), ('Разработка', '#b49cf0', 5), ('Услуги', '#6ea8fe', 6),
  ('Маркетинг', '#f08bb4', 7), ('Прочее', '#6b7785', 8)
) as c(name, color, pos)
where w.slug = 'first-logic';

-- ── расходы ─────────────────────────────────────────────────────────────────

create table fl_expenses (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  spent_on      date not null default current_date,
  category_id   uuid references fl_dicts(id) on delete set null,
  description   text not null check (length(trim(description)) between 1 and 300),
  amount        numeric(14, 2) not null check (amount > 0),
  currency      text not null default 'RUB' check (currency in ('RUB', 'USD', 'CNY', 'EUR')),
  -- курс на момент записи: сумма в рублях не «плывёт», когда курс меняется
  rate_rub      numeric(14, 6) not null default 1 check (rate_rub > 0),
  amount_rub    numeric(16, 2) generated always as (round(amount * rate_rub, 2)) stored,
  supplier_id   uuid references fl_suppliers(id) on delete set null,
  product_id    uuid references fl_products(id) on delete set null,
  component_id  uuid references fl_components(id) on delete set null,
  note          text not null default '',
  -- откуда запись: вручную в dashboard или из Telegram-бота
  source        text not null default 'dashboard' check (source in ('dashboard', 'telegram')),
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index fl_expenses_ws_idx on fl_expenses (workspace_id, spent_on desc);
create index fl_expenses_product_idx on fl_expenses (product_id);
create index fl_expenses_supplier_idx on fl_expenses (supplier_id);

create trigger fl_expenses_touch before update on fl_expenses
  for each row execute function fl_touch_updated();

create function fl_expenses_check() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.currency = 'RUB' then new.rate_rub := 1; end if;
  if new.category_id is not null and not exists (
       select 1 from fl_dicts where id = new.category_id and workspace_id = new.workspace_id and kind = 'expense_category') then
    raise exception 'категория расхода не найдена';
  end if;
  if new.supplier_id is not null and not exists (select 1 from fl_suppliers where id = new.supplier_id and workspace_id = new.workspace_id) then
    raise exception 'поставщик не найден';
  end if;
  if new.product_id is not null and not exists (select 1 from fl_products where id = new.product_id and workspace_id = new.workspace_id) then
    raise exception 'изделие не найдено';
  end if;
  if new.component_id is not null and not exists (select 1 from fl_components where id = new.component_id and workspace_id = new.workspace_id) then
    raise exception 'компонент не найден';
  end if;
  return new;
end
$$;
create trigger fl_expenses_check before insert or update on fl_expenses
  for each row execute function fl_expenses_check();

create function fl_expenses_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare r fl_expenses := case when tg_op = 'DELETE' then old else new end;
begin
  perform ws_log(r.workspace_id, null, 'expense', r.id,
                 case tg_op when 'INSERT' then 'expense.created' when 'DELETE' then 'expense.deleted' else 'expense.edited' end,
                 jsonb_build_object('title', r.description, 'to', r.amount_rub::text,
                                    'product', (select name from fl_products where id = r.product_id)));
  return r;
end
$$;
create trigger fl_expenses_log after insert or delete on fl_expenses
  for each row execute function fl_expenses_log();
create trigger fl_expenses_log_upd after update of amount, currency, rate_rub, description on fl_expenses
  for each row execute function fl_expenses_log();

-- ── параметры себестоимости изделия ─────────────────────────────────────────
-- Всё в рублях за единицу. Полная себестоимость =
--   материалы (BOM) + производство + прочее + накладные% × (материалы + производство)
-- cost_override — ручная себестоимость; расчёт и разница видны рядом.

alter table fl_products
  add column manufacturing_cost numeric(14, 2) not null default 0 check (manufacturing_cost >= 0),
  add column additional_cost    numeric(14, 2) not null default 0 check (additional_cost >= 0),
  add column overhead_pct       numeric(6, 2)  not null default 0 check (overhead_pct between 0 and 1000),
  add column cost_override      numeric(14, 2) check (cost_override is null or cost_override >= 0),
  -- план продаж, шт: из него плановая выручка и прибыль на обзоре и в финансах
  add column planned_qty        integer not null default 0 check (planned_qty >= 0);

-- ── файлы: чеки и документы расходов ────────────────────────────────────────

alter table ws_attachments add column expense_id uuid references fl_expenses(id) on delete cascade;
alter table ws_attachments drop constraint ws_attachments_target_check;
alter table ws_attachments add constraint ws_attachments_target_check
  check (num_nonnulls(task_id, message_id, component_id, supplier_id, product_id, assembly_id, expense_id) = 1);
create index ws_attachments_expense_idx on ws_attachments (expense_id);

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
    (select workspace_id from fl_assemblies where id = new.assembly_id),
    (select workspace_id from fl_expenses where id = new.expense_id)
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
      or (expense_id is not null and exists (
            select 1 from fl_expenses e where e.id = expense_id and ws_is_member(e.workspace_id)))
    )
  );

-- ── поиск: плюс расходы ─────────────────────────────────────────────────────

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
                              'products', '[]'::jsonb, 'assemblies', '[]'::jsonb,
                              'expenses', '[]'::jsonb);
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
      select id, task_id, component_id, supplier_id, product_id, assembly_id, expense_id, filename, size from ws_attachments
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
      order by name limit 8) x), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(x) from (
      select id, spent_on, description, amount_rub from fl_expenses
      where workspace_id = p_ws and (description ilike v_like or note ilike v_like)
      order by spent_on desc limit 8) x), '[]'::jsonb)
  );
end
$$;

-- ── RLS и права ─────────────────────────────────────────────────────────────

alter table fl_expenses enable row level security;
create policy "расходы: участники" on fl_expenses
  for all to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));

revoke all on fl_expenses from anon, authenticated;
grant select, insert, delete on fl_expenses to authenticated;
-- amount_rub вычисляемая: писать её нельзя, поэтому update по колонкам
grant update (spent_on, category_id, description, amount, currency, rate_rub, supplier_id, product_id,
              component_id, note) on fl_expenses to authenticated;

alter publication supabase_realtime add table fl_expenses;

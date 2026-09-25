-- Склад в работе: сборки со списанием по составу, заказы поставщикам с приёмкой,
-- предложения нескольких поставщиков на компонент, утренняя сводка в Telegram.

-- ── исправление 0009: компонент в составе изделия ───────────────────────────
-- Проверка «узел не содержит сам себя» была записана как
-- child_assembly_id IS DISTINCT FROM parent_assembly_id — для строки
-- «изделие → компонент» оба поля пустые, и вставка падала. Имя ограничения
-- Postgres выдал сам, поэтому ищем его по определению.

do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'fl_bom_items'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%child_assembly_id IS DISTINCT FROM parent_assembly_id%'
  loop
    execute format('alter table fl_bom_items drop constraint %I', c);
  end loop;
end $$;
alter table fl_bom_items add constraint fl_bom_items_not_self
  check (child_assembly_id is null or parent_assembly_id is null or child_assembly_id <> parent_assembly_id);

-- ── причина изменения остатка в истории компонента ──────────────────────────
-- Массовые операции (сборка, приёмка) ставят fl.reason на время транзакции:
-- строка «остаток 10 → 4» в истории компонента получает причину, а общая
-- лента показывает одну строку об операции, а не по строке на каждую деталь.

create or replace function fl_components_log() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  v_reason text := nullif(current_setting('fl.reason', true), '');
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
                                      'to', new.price::text || ' ' || new.currency, 'reason', v_reason));
  end if;
  if new.stock is distinct from old.stock then
    perform ws_log(new.workspace_id, null, 'component', new.id, 'component.stock',
                   jsonb_build_object('title', new.name, 'from', old.stock::text, 'to', new.stock::text,
                                      'unit', new.unit, 'reason', v_reason));
  end if;
  if new.archived_at is distinct from old.archived_at then
    perform ws_log(new.workspace_id, null, 'component', new.id,
                   case when new.archived_at is null then 'component.restored' else 'component.archived' end,
                   jsonb_build_object('title', new.name));
  end if;
  return new;
end
$$;

-- ── раскрытие состава до компонентов ────────────────────────────────────────

create function fl_explode(p_product uuid, p_assembly uuid, p_qty numeric)
returns table (component_id uuid, qty numeric)
language sql stable
set search_path = public
as $$
  with recursive t(component_id, child_assembly_id, qty, depth) as (
    select b.component_id, b.child_assembly_id, b.qty * p_qty, 1
      from fl_bom_items b
     where (p_product is not null and b.parent_product_id = p_product)
        or (p_assembly is not null and b.parent_assembly_id = p_assembly)
    union all
    select b.component_id, b.child_assembly_id, b.qty * t.qty, t.depth + 1
      from fl_bom_items b join t on b.parent_assembly_id = t.child_assembly_id
     where t.depth < 20
  )
  select t.component_id, sum(t.qty) from t where t.component_id is not null group by t.component_id
$$;

-- ── сборки ──────────────────────────────────────────────────────────────────

create table fl_builds (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  product_id    uuid references fl_products(id) on delete set null,
  assembly_id   uuid references fl_assemblies(id) on delete set null,
  -- что собирали: название на момент сборки (изделие могут потом переименовать или удалить)
  title         text not null,
  qty           numeric(14, 3) not null check (qty > 0),
  note          text not null default '',
  -- что списано: [{component_id, name, unit, qty}]
  lines         jsonb not null default '[]'::jsonb,
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  reverted_at   timestamptz,
  reverted_by   uuid references auth.users(id) on delete set null
);
create index fl_builds_ws_idx on fl_builds (workspace_id, created_at desc);
create index fl_builds_product_idx on fl_builds (product_id);
create index fl_builds_assembly_idx on fl_builds (assembly_id);

-- Собрали qty штук: компоненты по составу списываются со склада одной транзакцией.
-- Остаток может уйти в минус — это видно в интерфейсе до подтверждения.
create function fl_build(p_product uuid, p_assembly uuid, p_qty numeric, p_note text default '') returns uuid
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  v_ws uuid;
  v_title text;
  v_id uuid;
  v_lines jsonb;
begin
  if num_nonnulls(p_product, p_assembly) <> 1 then raise exception 'укажите изделие или узел'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'количество должно быть больше нуля'; end if;
  if p_product is not null then
    select workspace_id, name || coalesce(' ' || version, '') into v_ws, v_title from fl_products where id = p_product;
  else
    select workspace_id, name into v_ws, v_title from fl_assemblies where id = p_assembly;
  end if;
  if v_ws is null then raise exception 'изделие или узел не найдены'; end if;
  if auth.uid() is not null and not ws_is_member(v_ws) then raise exception 'нет доступа'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('component_id', c.id, 'name', c.name, 'unit', c.unit, 'qty', e.qty)
                            order by c.name), '[]'::jsonb)
    into v_lines
    from fl_explode(p_product, p_assembly, p_qty) e join fl_components c on c.id = e.component_id;
  if jsonb_array_length(v_lines) = 0 then raise exception 'состав пуст — нечего списывать'; end if;

  perform set_config('fl.reason', 'Сборка: ' || v_title || ' × ' || trim(to_char(p_qty, 'FM999999990.###')), true);
  update fl_components c set stock = c.stock - e.qty
    from fl_explode(p_product, p_assembly, p_qty) e where c.id = e.component_id;
  perform set_config('fl.reason', '', true);

  insert into fl_builds (workspace_id, product_id, assembly_id, title, qty, note, lines)
  values (v_ws, p_product, p_assembly, v_title, p_qty, coalesce(p_note, ''), v_lines)
  returning id into v_id;

  perform ws_log(v_ws, null, case when p_product is not null then 'product' else 'assembly' end,
                 coalesce(p_product, p_assembly), 'build.done',
                 jsonb_build_object('title', v_title, 'to', trim(to_char(p_qty, 'FM999999990.###')),
                                    'lines', jsonb_array_length(v_lines)::text));
  return v_id;
end
$$;

-- Ошиблись — вернуть списанное на склад.
create function fl_build_revert(p_build uuid) returns void
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare b fl_builds;
begin
  select * into b from fl_builds where id = p_build for update;
  if b.id is null then raise exception 'сборка не найдена'; end if;
  if auth.uid() is not null and not ws_is_member(b.workspace_id) then raise exception 'нет доступа'; end if;
  if b.reverted_at is not null then raise exception 'сборка уже отменена'; end if;

  perform set_config('fl.reason', 'Отмена сборки: ' || b.title || ' × ' || trim(to_char(b.qty, 'FM999999990.###')), true);
  update fl_components c set stock = c.stock + (l ->> 'qty')::numeric
    from jsonb_array_elements(b.lines) l where c.id = (l ->> 'component_id')::uuid;
  perform set_config('fl.reason', '', true);

  update fl_builds set reverted_at = now(), reverted_by = auth.uid() where id = b.id;
  perform ws_log(b.workspace_id, null, case when b.product_id is not null then 'product' else 'assembly' end,
                 coalesce(b.product_id, b.assembly_id), 'build.reverted',
                 jsonb_build_object('title', b.title, 'to', trim(to_char(b.qty, 'FM999999990.###'))));
end
$$;

-- ── предложения поставщиков ─────────────────────────────────────────────────
-- Цена компонента у конкретного продавца. «Основное» предложение — это цена и
-- поставщик в самой карточке компонента; остальные — для сравнения.

create table fl_component_offers (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  component_id  uuid not null references fl_components(id) on delete cascade,
  supplier_id   uuid not null references fl_suppliers(id) on delete cascade,
  price         numeric(14, 4) not null default 0 check (price >= 0),
  currency      text not null default 'RUB' check (currency in ('RUB', 'USD', 'CNY', 'EUR')),
  sku           text,
  url           text,
  lead_time     text,
  note          text not null default '',
  updated_at    timestamptz not null default now(),
  unique (component_id, supplier_id)
);
create index fl_component_offers_supplier_idx on fl_component_offers (supplier_id);

create function fl_offers_before() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  new.workspace_id := (select workspace_id from fl_components where id = new.component_id);
  if new.workspace_id is null then raise exception 'компонент не найден'; end if;
  if not exists (select 1 from fl_suppliers where id = new.supplier_id and workspace_id = new.workspace_id) then
    raise exception 'поставщик не найден';
  end if;
  new.updated_at := now();
  return new;
end
$$;
create trigger fl_offers_before before insert or update on fl_component_offers
  for each row execute function fl_offers_before();

-- ── заказы поставщикам ──────────────────────────────────────────────────────

create table fl_purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references ws_workspaces(id) on delete cascade,
  num           int not null,
  supplier_id   uuid references fl_suppliers(id) on delete set null,
  status        text not null default 'draft' check (status in ('draft', 'ordered', 'received', 'cancelled')),
  expected_on   date,
  note          text not null default '',
  expense_id    uuid references fl_expenses(id) on delete set null,
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  ordered_at    timestamptz,
  received_at   timestamptz,
  updated_at    timestamptz not null default now(),
  unique (workspace_id, num)
);
create index fl_purchase_orders_ws_idx on fl_purchase_orders (workspace_id, created_at desc);

create table fl_purchase_order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references fl_purchase_orders(id) on delete cascade,
  component_id  uuid references fl_components(id) on delete set null,
  -- название на момент заказа: компонент могут потом переименовать или удалить
  name          text not null,
  unit          text not null default 'шт',
  qty           numeric(14, 3) not null check (qty > 0),
  price         numeric(14, 4) not null default 0 check (price >= 0),
  currency      text not null default 'RUB' check (currency in ('RUB', 'USD', 'CNY', 'EUR')),
  received_qty  numeric(14, 3) check (received_qty is null or received_qty >= 0),
  position      int not null default 0
);
create index fl_po_items_order_idx on fl_purchase_order_items (order_id, position);
create index fl_po_items_component_idx on fl_purchase_order_items (component_id);

create trigger fl_purchase_orders_touch before update on fl_purchase_orders
  for each row execute function fl_touch_updated();

-- Номер заказа — по порядку внутри workspace.
create function fl_purchase_orders_before() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  perform pg_advisory_xact_lock(hashtext('fl_po:' || new.workspace_id::text));
  new.num := coalesce((select max(num) from fl_purchase_orders where workspace_id = new.workspace_id), 0) + 1;
  if new.supplier_id is not null and not exists (
       select 1 from fl_suppliers where id = new.supplier_id and workspace_id = new.workspace_id) then
    raise exception 'поставщик не найден';
  end if;
  return new;
end
$$;
create trigger fl_purchase_orders_before before insert on fl_purchase_orders
  for each row execute function fl_purchase_orders_before();

-- Создать черновик заказа: [{component_id, qty, price?, currency?}].
-- Цена по умолчанию — предложение этого поставщика, иначе цена из карточки компонента.
create function fl_po_create(p_ws uuid, p_supplier uuid, p_items jsonb, p_note text default '', p_expected date default null)
returns uuid
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  v_id uuid;
  it jsonb;
  c fl_components;
  o fl_component_offers;
  v_pos int := 0;
begin
  if auth.uid() is not null and not ws_is_member(p_ws) then raise exception 'нет доступа'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'в заказе нет позиций'; end if;
  insert into fl_purchase_orders (workspace_id, num, supplier_id, note, expected_on)
  values (p_ws, 0, p_supplier, coalesce(p_note, ''), p_expected) returning id into v_id;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into c from fl_components where id = (it ->> 'component_id')::uuid and workspace_id = p_ws;
    if c.id is null then raise exception 'компонент не найден'; end if;
    o := null;
    if p_supplier is not null then
      select * into o from fl_component_offers where component_id = c.id and supplier_id = p_supplier;
    end if;
    v_pos := v_pos + 1;
    insert into fl_purchase_order_items (order_id, component_id, name, unit, qty, price, currency, position)
    values (v_id, c.id, c.name, c.unit, (it ->> 'qty')::numeric,
            coalesce((it ->> 'price')::numeric, case when o.id is not null and o.price > 0 then o.price end, c.price),
            coalesce(it ->> 'currency', case when o.id is not null and o.price > 0 then o.currency end, c.currency),
            v_pos);
  end loop;
  perform ws_log(p_ws, null, 'order', v_id, 'order.created',
                 jsonb_build_object('title', 'Заказ №' || (select num from fl_purchase_orders where id = v_id),
                                    'supplier', (select name from fl_suppliers where id = p_supplier),
                                    'lines', jsonb_array_length(p_items)::text));
  return v_id;
end
$$;

-- Отправлен поставщику / отменён. Отправленный помечает компоненты «Заказан».
create function fl_po_set_status(p_order uuid, p_status text) returns void
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare po fl_purchase_orders;
begin
  select * into po from fl_purchase_orders where id = p_order for update;
  if po.id is null then raise exception 'заказ не найден'; end if;
  if auth.uid() is not null and not ws_is_member(po.workspace_id) then raise exception 'нет доступа'; end if;
  if p_status not in ('draft', 'ordered', 'cancelled') then raise exception 'недопустимый статус'; end if;
  if po.status = 'received' then raise exception 'заказ уже принят'; end if;

  update fl_purchase_orders
     set status = p_status, ordered_at = case when p_status = 'ordered' then coalesce(ordered_at, now()) else ordered_at end
   where id = po.id;

  if p_status = 'ordered' then
    update fl_components set status = 'ordered'
     where status = 'active' and id in (select component_id from fl_purchase_order_items where order_id = po.id);
  else
    -- «Заказан» снимаем, если по компоненту не осталось других открытых заказов
    update fl_components c set status = 'active'
     where c.status = 'ordered'
       and c.id in (select component_id from fl_purchase_order_items where order_id = po.id)
       and not exists (select 1 from fl_purchase_order_items i join fl_purchase_orders o2 on o2.id = i.order_id
                        where i.component_id = c.id and o2.id <> po.id and o2.status = 'ordered');
  end if;
  perform ws_log(po.workspace_id, null, 'order', po.id, 'order.' || p_status,
                 jsonb_build_object('title', 'Заказ №' || po.num, 'supplier', (select name from fl_suppliers where id = po.supplier_id)));
end
$$;

-- Приёмка. p_lines: [{item_id, qty}] — сколько реально пришло; null — всё по заказу.
-- Остаток растёт, «Заказан» снимается, по желанию — цена в карточке компонента
-- и расход в Финансы (одна валюта — в ней, разные — в рублях по текущему курсу).
create function fl_po_receive(p_order uuid, p_lines jsonb default null, p_update_prices boolean default true,
                              p_expense boolean default true) returns uuid
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  po fl_purchase_orders;
  v_sup text;
  v_cur text;
  v_amount numeric;
  v_rate numeric;
  v_cat uuid;
  v_exp uuid;
begin
  select * into po from fl_purchase_orders where id = p_order for update;
  if po.id is null then raise exception 'заказ не найден'; end if;
  if auth.uid() is not null and not ws_is_member(po.workspace_id) then raise exception 'нет доступа'; end if;
  if po.status in ('received', 'cancelled') then raise exception 'заказ уже % — принять нельзя',
     case po.status when 'received' then 'принят' else 'отменён' end; end if;

  update fl_purchase_order_items i
     set received_qty = coalesce((select (l ->> 'qty')::numeric from jsonb_array_elements(p_lines) l
                                   where (l ->> 'item_id')::uuid = i.id), case when p_lines is null then i.qty else 0 end)
   where i.order_id = po.id;

  v_sup := (select name from fl_suppliers where id = po.supplier_id);
  perform set_config('fl.reason', 'Приёмка заказа №' || po.num || coalesce(' (' || v_sup || ')', ''), true);
  update fl_components c
     set stock = c.stock + r.qty,
         price = case when p_update_prices and r.price > 0 then r.price else c.price end,
         currency = case when p_update_prices and r.price > 0 then r.currency else c.currency end,
         status = case when c.status = 'ordered' then 'active' else c.status end
    from (select component_id, sum(received_qty) as qty,
                 (array_agg(price order by position))[1] as price, (array_agg(currency order by position))[1] as currency
            from fl_purchase_order_items where order_id = po.id and component_id is not null and received_qty > 0
           group by component_id) r
   where c.id = r.component_id;
  perform set_config('fl.reason', '', true);

  if p_expense then
    select case when count(distinct currency) = 1 then min(currency) else 'RUB' end into v_cur
      from fl_purchase_order_items where order_id = po.id and received_qty > 0 and price > 0;
    if v_cur = 'RUB' then
      select sum(received_qty * price * coalesce(fl_rate(currency), 0)) into v_amount
        from fl_purchase_order_items where order_id = po.id and received_qty > 0 and price > 0;
    else
      select sum(received_qty * price) into v_amount
        from fl_purchase_order_items where order_id = po.id and received_qty > 0 and price > 0;
    end if;
    if v_amount > 0 then
      v_rate := fl_rate(v_cur);
      if v_rate is null then raise exception 'нет курса % — расход не записать; задайте курс или снимите «записать расход»', v_cur; end if;
      select id into v_cat from fl_dicts where workspace_id = po.workspace_id and kind = 'expense_category'
        and lower(name) = 'компоненты' limit 1;
      insert into fl_expenses (workspace_id, spent_on, category_id, description, amount, currency, rate_rub, supplier_id, note)
      values (po.workspace_id, current_date, v_cat, 'Заказ №' || po.num || coalesce(' — ' || v_sup, ''),
              round(v_amount, 2), v_cur, v_rate, po.supplier_id, 'Создано при приёмке заказа')
      returning id into v_exp;
    end if;
  end if;

  update fl_purchase_orders set status = 'received', received_at = now(), expense_id = coalesce(v_exp, expense_id) where id = po.id;
  perform ws_log(po.workspace_id, null, 'order', po.id, 'order.received',
                 jsonb_build_object('title', 'Заказ №' || po.num, 'supplier', v_sup,
                                    'lines', (select count(*)::text from fl_purchase_order_items where order_id = po.id and received_qty > 0)));
  perform fl_outbox_broadcast(po.workspace_id, 'order',
    '📦 Заказ №' || po.num || coalesce(' (' || v_sup || ')', '') || ' принят: '
      || (select count(*) from fl_purchase_order_items where order_id = po.id and received_qty > 0) || ' поз.',
    '/orders/' || po.id, 'po:' || po.id);
  return v_exp;
end
$$;

-- ── утренняя сводка и уведомления о заказах ─────────────────────────────────

alter table fl_notify_prefs drop constraint fl_notify_prefs_kind_check;
alter table fl_notify_prefs add constraint fl_notify_prefs_kind_check
  check (kind in ('task', 'comment', 'overdue', 'low_stock', 'price', 'product_status', 'budget', 'expense', 'order', 'digest'));

-- Кому слать сводку: привязан Telegram и сводка не выключена.
create function fl_bot_digest_targets() returns table (member_id uuid, chat_id bigint)
language sql security definer
set search_path = public
set row_security = off
as $$
  select l.member_id, l.tg_chat_id from fl_tg_links l join ws_members m on m.id = l.member_id
   where m.status = 'active'
     and coalesce((select enabled from fl_notify_prefs p where p.member_id = l.member_id and p.kind = 'digest'), true)
$$;

create function fl_bot_digest(p_member uuid) returns jsonb
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare m ws_members; d date := (now() at time zone 'Europe/Moscow')::date;
begin
  select * into m from ws_members where id = p_member;
  if m.id is null then return null; end if;
  return jsonb_build_object(
    'name', m.name,
    'due_today', coalesce((select jsonb_agg(jsonb_build_object('num', num, 'title', title) order by num)
       from ws_tasks where workspace_id = m.workspace_id and assignee_id = m.user_id and archived_at is null
        and status <> 'done' and due_date = d), '[]'),
    'overdue', coalesce((select jsonb_agg(jsonb_build_object('num', num, 'title', title, 'due_date', due_date) order by due_date)
       from ws_tasks where workspace_id = m.workspace_id and assignee_id = m.user_id and archived_at is null
        and status <> 'done' and due_date < d), '[]'),
    'in_progress', (select count(*) from ws_tasks where workspace_id = m.workspace_id and assignee_id = m.user_id
        and archived_at is null and status = 'in_progress'),
    'free', (select count(*) from ws_tasks where workspace_id = m.workspace_id and assignee_id is null
        and archived_at is null and status not in ('done', 'backlog')),
    'low', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'stock', stock, 'min', min_stock, 'unit', unit) order by name)
       from fl_components where workspace_id = m.workspace_id and archived_at is null and status <> 'obsolete'
        and min_stock > 0 and stock <= min_stock), '[]'),
    'orders_due', coalesce((select jsonb_agg(jsonb_build_object('num', o.num, 'supplier', s.name, 'expected_on', o.expected_on) order by o.expected_on)
       from fl_purchase_orders o left join fl_suppliers s on s.id = o.supplier_id
       where o.workspace_id = m.workspace_id and o.status = 'ordered' and o.expected_on <= d), '[]')
  );
end
$$;

-- Бот: собрать N штук (после подтверждения) — от имени участника, как и прочие команды.
create or replace function fl_bot_build(p_member uuid, p_product uuid, p_qty numeric) returns uuid
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare m ws_members;
begin
  select * into m from ws_members where id = p_member and status = 'active';
  if m.id is null then raise exception 'участник не найден'; end if;
  perform fl_bot_act_as(m.user_id);
  return fl_build(p_product, null, p_qty, 'Через Telegram');
end
$$;

revoke all on function fl_bot_digest_targets, fl_bot_digest, fl_bot_build from public, anon, authenticated;
grant execute on function fl_bot_digest_targets, fl_bot_digest, fl_bot_build to service_role;

-- ── поиск: плюс заказы ──────────────────────────────────────────────────────
-- (номер заказа «№12» или имя поставщика)

create function fl_search_orders(p_ws uuid, p_q text) returns jsonb
language sql stable
set search_path = public
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select o.id, o.num, o.status, s.name as supplier from fl_purchase_orders o left join fl_suppliers s on s.id = o.supplier_id
     where o.workspace_id = p_ws
       and (o.num::text = ltrim(trim(p_q), '№#') or s.name ilike '%' || trim(p_q) || '%' or o.note ilike '%' || trim(p_q) || '%')
     order by o.created_at desc limit 8) x
$$;

-- ── RLS и права ─────────────────────────────────────────────────────────────

alter table fl_builds               enable row level security;
alter table fl_component_offers     enable row level security;
alter table fl_purchase_orders      enable row level security;
alter table fl_purchase_order_items enable row level security;

create policy "сборки видят участники" on fl_builds
  for select to authenticated using (ws_is_member(workspace_id));
create policy "предложения: участники" on fl_component_offers
  for all to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));
create policy "заказы видят участники" on fl_purchase_orders
  for select to authenticated using (ws_is_member(workspace_id));
create policy "заказы правят участники" on fl_purchase_orders
  for update to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));
-- принятый заказ уже изменил склад и расходы — его не удалить, только черновик или отменённый
create policy "удалить можно черновик или отменённый" on fl_purchase_orders
  for delete to authenticated using (ws_is_member(workspace_id) and status in ('draft', 'cancelled'));
create policy "строки заказов видят участники" on fl_purchase_order_items
  for select to authenticated
  using (exists (select 1 from fl_purchase_orders o where o.id = order_id and ws_is_member(o.workspace_id)));
-- состав заказа меняется только пока он черновик
create policy "строки черновика правят участники" on fl_purchase_order_items
  for all to authenticated
  using (exists (select 1 from fl_purchase_orders o where o.id = order_id and ws_is_member(o.workspace_id) and o.status = 'draft'))
  with check (exists (select 1 from fl_purchase_orders o where o.id = order_id and ws_is_member(o.workspace_id) and o.status = 'draft'));

revoke all on fl_builds, fl_component_offers, fl_purchase_orders, fl_purchase_order_items from anon, authenticated;
-- сборки меняются только функциями fl_build / fl_build_revert
grant select on fl_builds to authenticated;
grant select, insert, update, delete on fl_component_offers, fl_purchase_order_items to authenticated;
grant select, delete on fl_purchase_orders to authenticated;
grant update (supplier_id, expected_on, note) on fl_purchase_orders to authenticated;
grant execute on function fl_explode, fl_build, fl_build_revert, fl_po_create, fl_po_set_status, fl_po_receive,
  fl_search_orders to authenticated;

alter publication supabase_realtime add table fl_builds, fl_component_offers, fl_purchase_orders, fl_purchase_order_items;

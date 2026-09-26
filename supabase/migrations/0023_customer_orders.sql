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

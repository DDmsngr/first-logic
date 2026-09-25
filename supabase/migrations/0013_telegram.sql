-- Telegram-бот: привязка аккаунтов, подтверждения, настройки и очередь уведомлений.
--
-- Бот (Cloudflare Worker, папка bot/) ходит в базу с service_role и вызывает
-- только функции fl_bot_*. Команду он выполняет через fl_bot_apply ОТ ИМЕНИ
-- привязанного участника: журнал показывает автора, а триггеры проверяют всё
-- так же, как при правке из dashboard. Отдельной системы данных у бота нет.

-- ── привязка Telegram ↔ участник ────────────────────────────────────────────

create table fl_tg_links (
  member_id    uuid primary key references ws_members(id) on delete cascade,
  tg_user_id   bigint not null unique,
  tg_chat_id   bigint not null,
  tg_username  text,
  linked_at    timestamptz not null default now()
);

create table fl_tg_link_codes (
  code        text primary key,
  member_id   uuid not null references ws_members(id) on delete cascade,
  expires_at  timestamptz not null default now() + interval '15 minutes'
);

-- Код для /start в боте. Старые коды участника гасятся.
create function fl_tg_create_link_code() returns text
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  m ws_members;
  v_code text;
begin
  select * into m from ws_members where user_id = auth.uid() and status = 'active' order by created_at limit 1;
  if m.id is null then raise exception 'нет доступа'; end if;
  delete from fl_tg_link_codes where member_id = m.id or expires_at < now();
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into fl_tg_link_codes (code, member_id) values (v_code, m.id);
  return v_code;
end
$$;

create function fl_tg_unlink() returns void
language sql security definer
set search_path = public
set row_security = off
as $$
  delete from fl_tg_links where member_id in (select id from ws_members where user_id = auth.uid())
$$;

-- ── настройки уведомлений ───────────────────────────────────────────────────
-- Нет строки — вид включён. Выключить = enabled false.

create table fl_notify_prefs (
  member_id  uuid not null references ws_members(id) on delete cascade,
  kind       text not null check (kind in ('task', 'comment', 'overdue', 'low_stock', 'price', 'product_status', 'budget', 'expense')),
  enabled    boolean not null default true,
  primary key (member_id, kind)
);

-- месячный бюджет расходов (₽) — для уведомления «превышение бюджета»
alter table ws_workspaces add column monthly_budget numeric(14, 2) check (monthly_budget is null or monthly_budget > 0);

-- ── очередь уведомлений ─────────────────────────────────────────────────────

create table fl_outbox (
  id          bigint generated always as identity primary key,
  member_id   uuid not null references ws_members(id) on delete cascade,
  kind        text not null,
  text        text not null,
  link        text,
  dedupe      text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  attempts    int not null default 0,
  error       text,
  unique (member_id, dedupe)
);
create index fl_outbox_unsent_idx on fl_outbox (created_at) where sent_at is null;

-- В очередь попадает только тому, у кого привязан Telegram и вид не выключен.
create function fl_outbox_push(p_member uuid, p_kind text, p_text text, p_link text, p_dedupe text default null) returns void
language sql security definer
set search_path = public
set row_security = off
as $$
  insert into fl_outbox (member_id, kind, text, link, dedupe)
  select p_member, p_kind, p_text, p_link, p_dedupe
  where exists (select 1 from fl_tg_links where member_id = p_member)
    and coalesce((select enabled from fl_notify_prefs where member_id = p_member and kind = p_kind), true)
  on conflict (member_id, dedupe) do nothing
$$;

-- Всем активным участникам, кроме автора изменения.
create function fl_outbox_broadcast(p_ws uuid, p_kind text, p_text text, p_link text, p_dedupe text default null) returns void
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare m record;
begin
  for m in select id, user_id from ws_members where workspace_id = p_ws and status = 'active' and user_id is not null loop
    continue when m.user_id = auth.uid();
    perform fl_outbox_push(m.id, p_kind, p_text, p_link, p_dedupe);
  end loop;
end
$$;
revoke all on function fl_outbox_push, fl_outbox_broadcast from public, anon, authenticated;

-- уведомления задач (назначение, статус, комментарий, просрочка…) → Telegram
create function fl_outbox_from_notification() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare v_member uuid;
begin
  select id into v_member from ws_members where workspace_id = new.workspace_id and user_id = new.user_id;
  if v_member is null then return new; end if;
  perform fl_outbox_push(v_member,
    case new.kind when 'comment' then 'comment' when 'mention' then 'comment' when 'overdue' then 'overdue' else 'task' end,
    new.title, new.link, 'n:' || new.id);
  return new;
end
$$;
create trigger fl_outbox_from_notification after insert on ws_notifications
  for each row execute function fl_outbox_from_notification();

-- остаток дошёл до минимума; цена компонента изменилась
create function fl_outbox_components() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if new.min_stock > 0 and new.status <> 'obsolete' and new.stock <= new.min_stock and old.stock > old.min_stock then
    perform fl_outbox_broadcast(new.workspace_id, 'low_stock',
      '⚠️ Пора заказать: «' || new.name || '» — осталось ' || trim(to_char(new.stock, 'FM999999990.###')) || ' ' || new.unit
        || ' (минимум ' || trim(to_char(new.min_stock, 'FM999999990.###')) || ')',
      '/components/' || new.id, 'low:' || new.id || ':' || current_date);
  end if;
  if (new.price, new.currency) is distinct from (old.price, old.currency) then
    perform fl_outbox_broadcast(new.workspace_id, 'price',
      '💱 Цена «' || new.name || '»: ' || trim(to_char(old.price, 'FM999999990.####')) || ' ' || old.currency
        || ' → ' || trim(to_char(new.price, 'FM999999990.####')) || ' ' || new.currency,
      '/components/' || new.id, null);
  end if;
  return new;
end
$$;
create trigger fl_outbox_components after update of stock, min_stock, price, currency on fl_components
  for each row execute function fl_outbox_components();

-- статус изделия (например, разработка → производство)
create function fl_outbox_products() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
begin
  if new.status_id is distinct from old.status_id then
    perform fl_outbox_broadcast(new.workspace_id, 'product_status',
      '📦 «' || new.name || '»: ' || coalesce((select name from fl_dicts where id = old.status_id), 'без статуса')
        || ' → ' || coalesce((select name from fl_dicts where id = new.status_id), 'без статуса'),
      '/products/' || new.id, null);
  end if;
  return new;
end
$$;
create trigger fl_outbox_products after update of status_id on fl_products
  for each row execute function fl_outbox_products();

-- новый расход (для тех, кто хочет видеть все траты) и превышение месячного бюджета
create function fl_outbox_expenses() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  v_budget numeric := (select monthly_budget from ws_workspaces where id = new.workspace_id);
  v_month numeric;
begin
  perform fl_outbox_broadcast(new.workspace_id, 'expense',
    '💸 Расход: ' || new.description || ' — ' || trim(to_char(new.amount_rub, 'FM999G999G990')) || ' ₽',
    '/finance', 'exp:' || new.id);
  if v_budget is not null then
    select coalesce(sum(amount_rub), 0) into v_month from fl_expenses
     where workspace_id = new.workspace_id and date_trunc('month', spent_on) = date_trunc('month', new.spent_on);
    if v_month > v_budget and v_month - new.amount_rub <= v_budget then
      perform fl_outbox_broadcast(new.workspace_id, 'budget',
        '🚨 Бюджет месяца превышен: ' || trim(to_char(v_month, 'FM999G999G990')) || ' ₽ из '
          || trim(to_char(v_budget, 'FM999G999G990')) || ' ₽',
        '/finance?period=month', 'budget:' || to_char(new.spent_on, 'YYYY-MM'));
    end if;
  end if;
  return new;
end
$$;
create trigger fl_outbox_expenses after insert on fl_expenses
  for each row execute function fl_outbox_expenses();

-- ── ожидающие подтверждения команды ─────────────────────────────────────────

create table fl_tg_pending (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references ws_members(id) on delete cascade,
  chat_id     bigint not null,
  message_id  bigint,
  source_text text not null,
  intent      jsonb not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '1 day'
);

-- ── функции для бота (только service_role) ──────────────────────────────────

-- Выполнить дальнейшие операции от имени пользователя: auth.uid() вернёт его id.
create function fl_bot_act_as(p_user uuid) returns void
language sql
as $$
  select set_config('request.jwt.claim.sub', p_user::text, true),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

create function fl_bot_redeem(p_code text, p_tg_user bigint, p_chat bigint, p_username text) returns jsonb
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare c fl_tg_link_codes; m ws_members;
begin
  select * into c from fl_tg_link_codes where code = upper(trim(p_code)) and expires_at > now();
  if c.code is null then raise exception 'код не найден или просрочен'; end if;
  select * into m from ws_members where id = c.member_id;
  delete from fl_tg_links where tg_user_id = p_tg_user or member_id = m.id;
  insert into fl_tg_links (member_id, tg_user_id, tg_chat_id, tg_username) values (m.id, p_tg_user, p_chat, p_username);
  delete from fl_tg_link_codes where code = c.code;
  return jsonb_build_object('name', m.name);
end
$$;

-- Кто пишет боту и всё, что нужно для разбора его сообщения.
create function fl_bot_context(p_tg_user bigint) returns jsonb
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare m ws_members; ws uuid;
begin
  select wm.* into m from fl_tg_links l join ws_members wm on wm.id = l.member_id
   where l.tg_user_id = p_tg_user and wm.status = 'active';
  if m.id is null then return null; end if;
  ws := m.workspace_id;
  return jsonb_build_object(
    'member', jsonb_build_object('id', m.id, 'user_id', m.user_id, 'name', m.name, 'workspace_id', ws),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'version', version, 'sku', sku) order by name)
                 from fl_products where workspace_id = ws and archived_at is null), '[]'),
    'components', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'sku', sku, 'unit', unit, 'stock', stock,
                   'min_stock', min_stock, 'price', price, 'currency', currency) order by name)
                 from fl_components where workspace_id = ws and archived_at is null), '[]'),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
                 from fl_suppliers where workspace_id = ws and archived_at is null), '[]'),
    'expense_categories', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by position)
                 from fl_dicts where workspace_id = ws and kind = 'expense_category'), '[]'),
    'component_categories', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by position)
                 from fl_dicts where workspace_id = ws and kind = 'component_category'), '[]'),
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'name', name))
                 from ws_members where workspace_id = ws and status = 'active' and user_id is not null), '[]'),
    'my_tasks', coalesce((select jsonb_agg(jsonb_build_object('num', num, 'title', title, 'status', status, 'due_date', due_date) order by due_date nulls last)
                 from ws_tasks where workspace_id = ws and assignee_id = m.user_id and archived_at is null and status <> 'done'), '[]')
  );
end
$$;

-- Выполнить разобранную команду. Одна транзакция: либо всё, либо ничего.
create function fl_bot_apply(p_member uuid, p_intent jsonb) returns jsonb
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  m ws_members;
  i jsonb := p_intent;
  k text := p_intent ->> 'intent';
  v_project uuid;
  v_id uuid;
  v_num int;
  v_rate numeric;
  c fl_components;
begin
  select * into m from ws_members where id = p_member and status = 'active';
  if m.id is null then raise exception 'участник не найден'; end if;
  perform fl_bot_act_as(m.user_id);

  if k = 'create_task' then
    select id into v_project from ws_projects where workspace_id = m.workspace_id and archived_at is null order by created_at limit 1;
    insert into ws_tasks (workspace_id, project_id, title, description, priority, due_date, product_id, assignee_id, status)
    values (m.workspace_id, v_project, i ->> 'title', coalesce(i ->> 'description', ''),
            coalesce(i ->> 'priority', 'medium'), (i ->> 'due_date')::date, (i ->> 'product_id')::uuid,
            (i ->> 'assignee_user_id')::uuid, 'todo')
    returning id, num into v_id, v_num;
    return jsonb_build_object('id', v_id, 'num', v_num, 'link', '/tasks/' || v_id);

  elsif k = 'update_task' then
    update ws_tasks set status = coalesce(i ->> 'status', status), due_date = coalesce((i ->> 'due_date')::date, due_date)
     where workspace_id = m.workspace_id and num = (i ->> 'task_num')::int
    returning id, num into v_id, v_num;
    if v_id is null then raise exception 'задача #% не найдена', i ->> 'task_num'; end if;
    return jsonb_build_object('id', v_id, 'num', v_num, 'link', '/tasks/' || v_id);

  elsif k = 'create_expense' then
    v_rate := fl_rate(coalesce(i ->> 'currency', 'RUB'));
    if v_rate is null then raise exception 'нет курса %', i ->> 'currency'; end if;
    insert into fl_expenses (workspace_id, spent_on, category_id, description, amount, currency, rate_rub,
                             supplier_id, product_id, component_id, note, source, created_by)
    values (m.workspace_id, coalesce((i ->> 'spent_on')::date, current_date), (i ->> 'category_id')::uuid, i ->> 'description',
            (i ->> 'amount')::numeric, coalesce(i ->> 'currency', 'RUB'), v_rate, (i ->> 'supplier_id')::uuid,
            (i ->> 'product_id')::uuid, (i ->> 'component_id')::uuid, coalesce(i ->> 'note', ''), 'telegram', m.user_id)
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'link', '/finance');

  elsif k = 'stock_in' or k = 'stock_out' then
    select * into c from fl_components where id = (i ->> 'component_id')::uuid and workspace_id = m.workspace_id;
    if c.id is null then raise exception 'компонент не найден'; end if;
    update fl_components
       set stock = stock + case when k = 'stock_in' then 1 else -1 end * (i ->> 'qty')::numeric,
           price = coalesce((i ->> 'price')::numeric, price),
           currency = case when i ? 'price' and i ->> 'price' is not null then coalesce(i ->> 'currency', currency) else currency end
     where id = c.id;
    return jsonb_build_object('id', c.id, 'link', '/components/' || c.id);

  elsif k = 'create_component' then
    insert into fl_components (workspace_id, name, sku, category_id, unit, price, currency, stock, supplier_id, created_by)
    values (m.workspace_id, i ->> 'name', i ->> 'sku', (i ->> 'category_id')::uuid, coalesce(i ->> 'unit', 'шт'),
            coalesce((i ->> 'price')::numeric, 0), coalesce(i ->> 'currency', 'RUB'), coalesce((i ->> 'qty')::numeric, 0),
            (i ->> 'supplier_id')::uuid, m.user_id)
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'link', '/components/' || v_id);

  elsif k = 'create_product' then
    insert into fl_products (workspace_id, name, version, description, created_by)
    values (m.workspace_id, i ->> 'name', i ->> 'version', coalesce(i ->> 'description', ''), m.user_id)
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'link', '/products/' || v_id);

  elsif k = 'create_assembly' then
    insert into fl_assemblies (workspace_id, name, description, created_by)
    values (m.workspace_id, i ->> 'name', coalesce(i ->> 'description', ''), m.user_id)
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'link', '/assemblies/' || v_id);

  elsif k = 'add_note' then
    update fl_products
       set notes = case when notes = '' then '' else notes || E'\n\n' end
                   || to_char(now() at time zone 'Europe/Moscow', 'DD.MM.YYYY') || ' (' || m.name || '): ' || (i ->> 'text')
     where id = (i ->> 'product_id')::uuid and workspace_id = m.workspace_id
    returning id into v_id;
    if v_id is null then raise exception 'изделие для заметки не найдено'; end if;
    return jsonb_build_object('id', v_id, 'link', '/products/' || v_id);
  end if;

  raise exception 'неизвестная команда %', k;
end
$$;

-- Непросроченные — просроченные задачи всех workspace (для бота раз в час).
create function fl_bot_sync_overdue() returns void
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare t record;
begin
  for t in
    select id, workspace_id, title, assignee_id, due_date from ws_tasks
    where archived_at is null and status <> 'done' and due_date < current_date and assignee_id is not null
  loop
    insert into ws_notifications (workspace_id, user_id, kind, title, link, dedupe)
    values (t.workspace_id, t.assignee_id, 'overdue', 'Задача «' || t.title || '» просрочена',
            '/tasks/' || t.id, 'overdue:' || t.id || ':' || t.due_date)
    on conflict (user_id, dedupe) do nothing;
  end loop;
end
$$;

-- Очередь для отправки: пачка неотправленных вместе с chat_id получателя.
create function fl_bot_outbox_batch(p_limit int default 30) returns table (id bigint, chat_id bigint, text text, link text)
language sql security definer
set search_path = public
set row_security = off
as $$
  select o.id, l.tg_chat_id, o.text, o.link
  from fl_outbox o join fl_tg_links l on l.member_id = o.member_id
  where o.sent_at is null and o.attempts < 5
  order by o.created_at
  limit p_limit
$$;

create function fl_bot_outbox_done(p_id bigint, p_error text default null) returns void
language sql security definer
set search_path = public
set row_security = off
as $$
  update fl_outbox
     set sent_at = case when p_error is null then now() end,
         attempts = attempts + 1, error = p_error
   where id = p_id
$$;

revoke all on function fl_bot_act_as, fl_bot_redeem, fl_bot_context, fl_bot_apply, fl_bot_sync_overdue,
  fl_bot_outbox_batch, fl_bot_outbox_done from public, anon, authenticated;
grant execute on function fl_bot_redeem, fl_bot_context, fl_bot_apply, fl_bot_sync_overdue,
  fl_bot_outbox_batch, fl_bot_outbox_done to service_role;

-- ── RLS и права ─────────────────────────────────────────────────────────────

alter table fl_tg_links      enable row level security;
alter table fl_tg_link_codes enable row level security;
alter table fl_notify_prefs  enable row level security;
alter table fl_outbox        enable row level security;
alter table fl_tg_pending    enable row level security;

create policy "своя привязка Telegram" on fl_tg_links
  for select to authenticated using (member_id in (select id from ws_members where user_id = auth.uid()));
create policy "свои настройки уведомлений" on fl_notify_prefs
  for all to authenticated
  using (member_id in (select id from ws_members where user_id = auth.uid()))
  with check (member_id in (select id from ws_members where user_id = auth.uid()));

revoke all on fl_tg_links, fl_tg_link_codes, fl_notify_prefs, fl_outbox, fl_tg_pending from anon, authenticated;
grant select on fl_tg_links to authenticated;
grant select, insert, update, delete on fl_notify_prefs to authenticated;
grant update (monthly_budget) on ws_workspaces to authenticated;
grant execute on function fl_tg_create_link_code, fl_tg_unlink to authenticated;
-- бот работает с service_role, RLS его не ограничивает
grant select, insert, update, delete on fl_tg_links, fl_tg_link_codes, fl_outbox, fl_tg_pending to service_role;

create policy "бюджет меняют участники" on ws_workspaces
  for update to authenticated using (ws_is_member(id)) with check (ws_is_member(id));

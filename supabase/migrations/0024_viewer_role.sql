-- Роль «наблюдатель» (viewer): видит всё в контуре, но ничего не меняет. Для заказчика,
-- подрядчика, бухгалтера, которым нужен статус, а не правка.
--
-- Защита держится на триггерах, а не на политиках: триггер срабатывает и на прямые записи
-- из браузера, и на записи внутри функций с правами владельца (сборка, заказы, бот от имени
-- пользователя) — в обоих случаях auth.uid() остаётся вошедшим человеком.

alter table ws_members drop constraint ws_members_role_check;
alter table ws_members add constraint ws_members_role_check check (role in ('owner', 'admin', 'member', 'viewer'));
alter table ws_invitations drop constraint ws_invitations_role_check;
alter table ws_invitations add constraint ws_invitations_role_check check (role in ('admin', 'member', 'viewer'));

create function ws_is_viewer(p_ws uuid) returns boolean
language sql stable security definer
set search_path = public
set row_security = off
as $$
  select exists (select 1 from ws_members where workspace_id = p_ws and user_id = auth.uid() and status = 'active' and role = 'viewer')
$$;

-- Приглашать можно и наблюдателя (только owner и admin, как и остальных).
create or replace function ws_invite_member(
  p_ws uuid, p_name text, p_email text, p_role text, p_message text default null
) returns text
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  v_member ws_members;
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not ws_is_admin(p_ws) then raise exception 'приглашать могут owner и admin'; end if;
  if p_role not in ('admin', 'member', 'viewer') then raise exception 'роль: admin, member или viewer'; end if;
  if p_role = 'admin' and ws_role(p_ws) <> 'owner' then
    raise exception 'администраторов приглашает только owner';
  end if;
  if position('@' in p_email) < 2 then raise exception 'некорректный email'; end if;
  if exists (select 1 from ws_members where workspace_id = p_ws and lower(email) = lower(p_email)) then
    raise exception 'участник с таким email уже есть';
  end if;

  insert into ws_members (workspace_id, email, name, role, status, invited_by)
  values (p_ws, trim(p_email), trim(p_name), p_role, 'invited', auth.uid())
  returning * into v_member;

  insert into ws_invitations (workspace_id, member_id, email, role, message, token_hash, invited_by)
  values (p_ws, v_member.id, v_member.email, p_role, nullif(trim(p_message), ''),
          sha256(convert_to(v_token, 'utf8')), auth.uid());

  perform ws_log(p_ws, null, 'member', v_member.id, 'member.invited',
                 jsonb_build_object('name', v_member.name, 'role', p_role));
  return v_token;
end
$$;

-- ── защита от записи ────────────────────────────────────────────────────────
-- TG_ARGV[0] — таблица-родитель ('' — workspace_id в самой строке), TG_ARGV[1] — колонка связи.
create function fl_viewer_guard() returns trigger
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  j jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_ws uuid;
begin
  if auth.uid() is null then return case when tg_op = 'DELETE' then old else new end; end if; -- сервис и cron
  if coalesce(tg_argv[0], '') = '' then
    v_ws := (j ->> coalesce(nullif(tg_argv[1], ''), 'workspace_id'))::uuid;
  else
    execute format('select workspace_id from %I where id = $1', tg_argv[0]) into v_ws using (j ->> tg_argv[1])::uuid;
  end if;
  if v_ws is not null and ws_is_viewer(v_ws) then
    raise exception 'наблюдатель не может менять данные';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

do $$
declare
  t text;
  -- таблицы, где контур определяется через родителя
  via constant jsonb := '{
    "fl_customer_order_items": ["fl_customer_orders", "order_id"],
    "fl_purchase_order_items": ["fl_purchase_orders", "order_id"],
    "fl_stocktake_lines": ["fl_stocktakes", "stocktake_id"],
    "fl_reservation_lines": ["fl_reservations", "reservation_id"],
    "ws_task_labels": ["ws_tasks", "task_id"],
    "ws_task_watchers": ["ws_tasks", "task_id"]
  }';
  -- личные данные и служебные журналы: наблюдатель их менять может (свой профиль, прочитано, привязка Telegram)
  skip constant text[] := array['ws_members', 'ws_activity', 'ws_notifications', 'ws_invitations',
                                'fl_notify_prefs', 'fl_tg_links', 'fl_tg_link_codes', 'fl_tg_pending', 'fl_outbox', 'fl_rates',
                                'ws_conversation_members'];
begin
  -- всё, что лежит в контуре
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'workspace_id')
              and c.relname <> all (skip)
  loop
    execute format('create trigger zzz_viewer_guard before insert or update or delete on %I for each row execute function fl_viewer_guard()', t);
  end loop;
  -- через родителя
  for t in select k from jsonb_object_keys(via) k loop
    execute format('create trigger zzz_viewer_guard before insert or update or delete on %I for each row execute function fl_viewer_guard(%L, %L)',
                   t, via -> t ->> 0, via -> t ->> 1);
  end loop;
end
$$;

-- сам контур (месячный бюджет): контур определяется по id
create trigger zzz_viewer_guard before update on ws_workspaces
  for each row execute function fl_viewer_guard('', 'id');
-- состав чата меняется через функции; чтение (last_read) остаётся доступным
create trigger zzz_viewer_guard before insert or delete on ws_conversation_members
  for each row execute function fl_viewer_guard('ws_conversations', 'conversation_id');

-- файлы в хранилище: загрузка и удаление в бакете контура — не для наблюдателя
create policy "наблюдатель не пишет файлы" on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id <> 'ws-files' or not ws_is_viewer(ws_storage_ws(name)));
create policy "наблюдатель не правит файлы" on storage.objects
  as restrictive for update to authenticated
  using (bucket_id <> 'ws-files' or not ws_is_viewer(ws_storage_ws(name)));
create policy "наблюдатель не удаляет файлы" on storage.objects
  as restrictive for delete to authenticated
  using (bucket_id <> 'ws-files' or not ws_is_viewer(ws_storage_ws(name)));

revoke execute on function fl_viewer_guard, ws_is_viewer from public, anon;
grant execute on function ws_is_viewer to authenticated, service_role;

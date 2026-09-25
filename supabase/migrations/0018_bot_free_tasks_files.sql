-- Бот: свободные задачи в контексте и прикрепление файла из Telegram.

create or replace function fl_bot_context(p_tg_user bigint) returns jsonb
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
                 from ws_tasks where workspace_id = ws and assignee_id = m.user_id and archived_at is null and status <> 'done'), '[]'),
    -- без исполнителя: «свободные задачи», которые можно взять
    'free_tasks', coalesce((select jsonb_agg(x) from (
                   select jsonb_build_object('num', num, 'title', title, 'status', status, 'priority', priority, 'due_date', due_date) x
                   from ws_tasks where workspace_id = ws and assignee_id is null and archived_at is null and status <> 'done'
                   order by due_date nulls last, num limit 30) s), '[]'),
    -- у других: чтобы отвечать «кто чем занят»
    'team_tasks', coalesce((select jsonb_agg(x) from (
                   select jsonb_build_object('num', t.num, 'title', t.title, 'status', t.status, 'due_date', t.due_date, 'assignee', a.name) x
                   from ws_tasks t left join ws_members a on a.user_id = t.assignee_id and a.workspace_id = t.workspace_id
                   where t.workspace_id = ws and t.assignee_id is not null and t.assignee_id <> m.user_id and t.archived_at is null and t.status <> 'done'
                   order by t.due_date nulls last, t.num limit 40) s), '[]')
  );
end
$$;

-- Файл из Telegram → карточка задачи или изделия. Сам файл бот кладёт в бакет ws-files
-- по пути <workspace>/<user>/<uuid>-<имя>; здесь — запись о нём от имени участника.
create function fl_bot_attach(
  p_member uuid, p_task uuid, p_product uuid, p_path text, p_filename text, p_mime text, p_size bigint
) returns uuid
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  m ws_members;
  v_ws uuid;
  v_id uuid;
begin
  select * into m from ws_members where id = p_member and status = 'active';
  if m.id is null then raise exception 'нет доступа'; end if;
  if num_nonnulls(p_task, p_product) <> 1 then raise exception 'укажите задачу или изделие'; end if;
  v_ws := coalesce(ws_task_ws(p_task), (select workspace_id from fl_products where id = p_product));
  if v_ws is distinct from m.workspace_id then raise exception 'нет доступа к этой записи'; end if;
  if split_part(p_path, '/', 2) <> m.user_id::text then raise exception 'путь файла не совпадает с участником'; end if;
  insert into ws_attachments (task_id, product_id, storage_path, filename, mime, size, uploader_id)
  values (p_task, p_product, p_path, left(p_filename, 200), p_mime, greatest(p_size, 0), m.user_id)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function fl_bot_attach from public, anon, authenticated;
grant execute on function fl_bot_attach to service_role;

-- Бот: взять задачу, отказаться от неё, оставить комментарий. Всё от имени участника,
-- через те же функции и триггеры, что и на сайте (ws_claim_task, комментарии с уведомлениями).

create function fl_bot_task_action(p_member uuid, p_intent jsonb) returns jsonb
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  m ws_members;
  k text := p_intent ->> 'intent';
  v_task ws_tasks;
begin
  select * into m from ws_members where id = p_member and status = 'active';
  if m.id is null then raise exception 'участник не найден'; end if;
  select * into v_task from ws_tasks
   where workspace_id = m.workspace_id and num = (p_intent ->> 'task_num')::int;
  if v_task.id is null then raise exception 'задача #% не найдена', p_intent ->> 'task_num'; end if;
  perform fl_bot_act_as(m.user_id);

  if k = 'claim_task' then
    perform ws_claim_task(v_task.id);
  elsif k = 'release_task' then
    perform ws_release_task(v_task.id);
  elsif k = 'add_comment' then
    if length(trim(coalesce(p_intent ->> 'text', ''))) = 0 then raise exception 'пустой комментарий'; end if;
    insert into ws_comments (workspace_id, task_id, body)
    values (m.workspace_id, v_task.id, left(trim(p_intent ->> 'text'), 4000));
  else
    raise exception 'неизвестное действие';
  end if;
  return jsonb_build_object('id', v_task.id, 'num', v_task.num, 'title', v_task.title, 'link', '/tasks/' || v_task.id);
end
$$;

revoke all on function fl_bot_task_action from public, anon, authenticated;
grant execute on function fl_bot_task_action to service_role;

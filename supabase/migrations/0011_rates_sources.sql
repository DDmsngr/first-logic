-- Курсы: ЦБ недоступен с серверов Supabase (cbr-xml-daily.ru не отвечает
-- зарубежным адресам). Основной путь теперь — браузер участника: он берёт
-- курс ЦБ и сохраняет через fl_set_cbr_rates. Серверная задача остаётся
-- запасной: пробует ЦБ, а если он недоступен и курс ЦБ устарел — берёт
-- рыночный курс open.er-api.com (помечается source = 'market').

alter table fl_rates add column source text not null default 'cbr' check (source in ('cbr', 'market'));

create or replace function fl_refresh_rates(p_force boolean default false) returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  r extensions.http_response;
  j jsonb;
begin
  if not p_force and exists (select 1 from fl_rates where fetched_at > now() - interval '10 minutes') then
    return;
  end if;

  begin
    select * into r from extensions.http_get('https://www.cbr-xml-daily.ru/daily_json.js');
    if r.status = 200 then
      j := r.content::jsonb;
      update fl_rates f
         set cbr_rate = (j -> 'Valute' -> f.currency ->> 'Value')::numeric
                      / (j -> 'Valute' -> f.currency ->> 'Nominal')::numeric,
             cbr_date = (j ->> 'Date')::timestamptz::date, source = 'cbr',
             fetched_at = now(), updated_at = now()
       where j -> 'Valute' ? f.currency;
      return;
    end if;
  exception when others then
    null;  -- ЦБ недоступен — пробуем запасной источник ниже
  end;

  -- свежий курс ЦБ (от браузера) рыночным не затираем
  if exists (select 1 from fl_rates where source = 'cbr' and fetched_at > now() - interval '36 hours') then
    return;
  end if;

  select * into r from extensions.http_get('https://open.er-api.com/v6/latest/USD');
  if r.status <> 200 then
    raise exception 'источники курсов недоступны (ЦБ и open.er-api: %)', r.status;
  end if;
  j := r.content::jsonb;
  if j ->> 'result' <> 'success' or (j -> 'rates' ->> 'RUB') is null then
    raise exception 'open.er-api вернул неожиданный ответ';
  end if;
  -- база USD: рублей за единицу X = RUB / X
  update fl_rates f
     set cbr_rate = (j -> 'rates' ->> 'RUB')::numeric / (j -> 'rates' ->> f.currency)::numeric,
         cbr_date = to_timestamp((j ->> 'time_last_update_unix')::bigint)::date, source = 'market',
         fetched_at = now(), updated_at = now()
   where (j -> 'rates' ->> f.currency) is not null;
end
$$;
revoke all on function fl_refresh_rates from public, anon;
grant execute on function fl_refresh_rates to authenticated;

-- Курс ЦБ, полученный браузером участника. Проверяем, что числа правдоподобные:
-- положительные и не дальше чем вдвое от предыдущего значения.
create function fl_set_cbr_rates(p_date date, p_rates jsonb) returns void
language plpgsql security definer
set search_path = public
set row_security = off
as $$
declare
  c text;
  v numeric;
  prev numeric;
begin
  if not exists (select 1 from ws_members where user_id = auth.uid() and status = 'active') then
    raise exception 'нет доступа';
  end if;
  if p_date is null or p_date > current_date + 2 or p_date < current_date - 14 then
    raise exception 'дата курса вне допустимого окна';
  end if;
  for c in select currency from fl_rates loop
    continue when not (p_rates ? c);
    v := (p_rates ->> c)::numeric;
    select cbr_rate into prev from fl_rates where currency = c;
    if v is null or v <= 0 or v > 100000 or (prev is not null and (v > prev * 2 or v < prev / 2)) then
      raise exception 'курс % выглядит неправдоподобно: %', c, v;
    end if;
    update fl_rates set cbr_rate = v, cbr_date = p_date, source = 'cbr', fetched_at = now(), updated_at = now()
     where currency = c;
  end loop;
end
$$;
revoke all on function fl_set_cbr_rates from public, anon;
grant execute on function fl_set_cbr_rates to authenticated;

-- сразу подтянуть хоть какой-то курс, чтобы не было пустых сумм
do $$
begin
  perform fl_refresh_rates(true);
exception when others then
  raise notice 'курсы не загрузились сейчас (%), подтянутся из браузера или по расписанию', sqlerrm;
end $$;

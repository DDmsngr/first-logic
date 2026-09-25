-- Документы: тип и описание у любого файла. Тип угадывается при загрузке
-- (фото, чек расхода, datasheet, чертёж), дальше его можно поменять.

alter table ws_attachments
  add column doc_type text not null default 'other'
    check (doc_type in ('drawing', 'datasheet', 'photo', 'manual', 'technical', 'commercial', 'receipt', 'other')),
  add column description text not null default '' check (length(description) <= 500);
create index ws_attachments_doc_type_idx on ws_attachments (workspace_id, doc_type);

create function fl_guess_doc_type(p_filename text, p_mime text, p_expense uuid) returns text
language sql immutable
as $$
  select case
    when p_expense is not null then 'receipt'
    when coalesce(p_mime, '') like 'image/%' or p_filename ~* '\.(png|jpe?g|gif|webp|avif|bmp|heic)$' then 'photo'
    when p_filename ~* '(datasheet|даташит|^ds[_-])' then 'datasheet'
    when p_filename ~* '\.(dwg|dxf|step|stp|igs|iges|sldprt|sldasm|f3d|pcbdoc|brd|kicad_pcb|gbr|ger)$'
      or p_filename ~* '(чертеж|чертёж|drawing|схема|schematic)' then 'drawing'
    when p_filename ~* '(инструкц|manual|руководств)' then 'manual'
    when p_filename ~* '(счет|счёт|invoice|кп|коммерческ|договор|contract|прайс|price)' then 'commercial'
    else 'other'
  end
$$;

create function fl_attachments_doc_type() returns trigger
language plpgsql
as $$
begin
  if new.doc_type = 'other' then
    new.doc_type := fl_guess_doc_type(new.filename, new.mime, new.expense_id);
  end if;
  return new;
end
$$;
create trigger fl_attachments_doc_type before insert on ws_attachments
  for each row execute function fl_attachments_doc_type();

update ws_attachments set doc_type = fl_guess_doc_type(filename, mime, expense_id);

-- Менять тип и описание может любой участник workspace (роли в команде равны).
create policy "тип и описание файла правят участники" on ws_attachments
  for update to authenticated using (ws_is_member(workspace_id)) with check (ws_is_member(workspace_id));
grant update (doc_type, description) on ws_attachments to authenticated;

-- Превью: одно фото на компонент/узел/изделие, показывается в списке без захода
-- в карточку. Само фото — обычный файл в ws_attachments (уже прикреплённый к
-- записи), preview_attachment_id только помечает, какой из файлов главный.

alter table fl_components add column preview_attachment_id uuid references ws_attachments(id) on delete set null;
alter table fl_assemblies add column preview_attachment_id uuid references ws_attachments(id) on delete set null;
alter table fl_products  add column preview_attachment_id uuid references ws_attachments(id) on delete set null;

-- Превью обязано быть файлом этой же записи — иначе можно было бы подставить
-- чужую картинку по её id.

create or replace function fl_components_check() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.category_id is not null and not exists (
       select 1 from fl_dicts where id = new.category_id
         and workspace_id = new.workspace_id and kind = 'component_category') then
    raise exception 'категория не найдена';
  end if;
  if new.supplier_id is not null and not exists (
       select 1 from fl_suppliers where id = new.supplier_id and workspace_id = new.workspace_id) then
    raise exception 'поставщик не найден';
  end if;
  if new.preview_attachment_id is not null and not exists (
       select 1 from ws_attachments where id = new.preview_attachment_id and component_id = new.id) then
    raise exception 'превью должно быть файлом этого компонента';
  end if;
  return new;
end
$$;

create or replace function fl_products_check() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status_id is not null and not exists (
       select 1 from fl_dicts where id = new.status_id
         and workspace_id = new.workspace_id and kind = 'product_status') then
    raise exception 'статус изделия не найден';
  end if;
  if new.preview_attachment_id is not null and not exists (
       select 1 from ws_attachments where id = new.preview_attachment_id and product_id = new.id) then
    raise exception 'превью должно быть файлом этого изделия';
  end if;
  return new;
end
$$;

create function fl_assemblies_check() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.preview_attachment_id is not null and not exists (
       select 1 from ws_attachments where id = new.preview_attachment_id and assembly_id = new.id) then
    raise exception 'превью должно быть файлом этого узла';
  end if;
  return new;
end
$$;
create trigger fl_assemblies_check before insert or update on fl_assemblies
  for each row execute function fl_assemblies_check();

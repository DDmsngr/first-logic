-- 0014 выдала права на функции склада только authenticated, но в Postgres новые функции
-- по умолчанию исполняет и PUBLIC. Внутри проверка «auth.uid() is not null and not member»
-- пропускает вызов без входа (так задумано для service_role) — значит, анонимный ключ
-- мог списать склад или принять заказ, зная uuid. Закрываем.
revoke execute on function fl_build, fl_build_revert, fl_po_create, fl_po_set_status, fl_po_receive,
  fl_explode, fl_search_orders, fl_test_result from public, anon;
grant execute on function fl_build, fl_build_revert, fl_po_create, fl_po_set_status, fl_po_receive,
  fl_explode, fl_search_orders, fl_test_result to authenticated, service_role;

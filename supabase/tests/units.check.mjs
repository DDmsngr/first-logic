import assert from 'node:assert/strict'
import { boot, seed, as } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message, e.detail ?? ''); process.exit(1) })

const db = await boot()
const { ws, u1, u2 } = await seed(db)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const ok = m => console.log('  ✓', m)
await db.exec(`grant usage on schema public to authenticated`)
const asAuth = (u, fn) => as(db, u, async () => { await db.exec('set role authenticated'); try { return await fn() } finally { await db.exec('reset role') } })
const T = (await one(`insert into fl_components (workspace_id, name, stock) values ($1, 'Транзистор', 100) returning id`, [ws])).id
const prod = (await one(`insert into fl_products (workspace_id, name, version) values ($1, 'Усилитель', 'v1') returning id`, [ws])).id
await db.exec(`insert into fl_bom_items (workspace_id, parent_product_id, component_id, qty) values ('${ws}', '${prod}', '${T}', 2)`)
const stock = async () => Number((await one(`select stock from fl_components where id = $1`, [T])).stock)
const units = async () => (await db.query(`select serial, status, build_id from fl_units order by serial`)).rows
const buildSerial = (n, serials, note = '') => asAuth(u1, () => one(`select fl_build_serial($1, $2, $3, $4::text[]) id`, [prod, n, note, serials])).then(x => x.id)
const unitId = async s => (await one(`select id from fl_units where serial = $1`, [s])).id

console.log('сборка с серийными номерами')
const b1 = await buildSerial(3, ['FL-001', 'FL-002', ' FL-003 '], 'партия 1')
assert.equal(await stock(), 94); ok('склад списан: 3 × 2 шт')
assert.deepEqual((await units()).map(u => u.serial), ['FL-001', 'FL-002', 'FL-003']); ok('созданы 3 экземпляра, пробелы обрезаны')
assert.ok((await units()).every(u => u.build_id === b1 && u.status === 'in_stock')); ok('все привязаны к сборке, на складе')
await assert.rejects(buildSerial(2, ['FL-004', 'FL-004']), /повторяется/); ok('дубль внутри списка отклонён')
await assert.rejects(buildSerial(2, ['fl-003', 'FL-005']), /уже есть/); ok('номер, который уже есть у изделия, отклонён (без учёта регистра)')
await assert.rejects(buildSerial(2, ['FL-006']), /должно совпадать/); ok('число номеров должно равняться количеству')
await assert.rejects(buildSerial(1.5, ['A', 'B']), /целым/); ok('дробное количество с номерами отклонено')
assert.equal(await stock(), 94); ok('при ошибке склад не тронут (одна транзакция)')
await buildSerial(2, [], 'без номеров')
assert.equal(await stock(), 90); assert.equal((await units()).length, 3); ok('без номеров — обычная сборка, экземпляры не создаются')

console.log('отгрузка и брак')
await asAuth(u2, async () => db.query(`update fl_units set status = 'shipped', customer = 'ООО «Радиосвязь»' where id = $1`, [await unitId('FL-001')]))
const s1 = await one(`select status, shipped_on from fl_units where serial = 'FL-001'`)
assert.equal(s1.status, 'shipped'); assert.ok(s1.shipped_on); ok('отгружен: дата поставилась сама')
assert.ok((await db.query(`select 1 from ws_activity where action = 'unit.shipped' and entity_id = $1`, [prod])).rows.length); ok('в истории изделия: unit.shipped')
await asAuth(u2, async () => db.query(`update fl_units set status = 'scrap' where id = $1`, [await unitId('FL-002')]))
assert.equal((await one(`select status from fl_units where serial = 'FL-002'`)).status, 'scrap'); ok('в брак')
await assert.rejects(asAuth(u1, async () => db.query(`update fl_units set serial = 'X' where id = $1`, [await unitId('FL-003')])), /permission denied/); ok('серийный номер править нельзя')
const del = await asAuth(u1, async () => db.query(`delete from fl_units where id = $1 returning id`, [await unitId('FL-001')]))
assert.equal(del.rows.length, 0); ok('отгруженный экземпляр не удалить')

console.log('отмена сборки')
await assert.rejects(asAuth(u1, () => db.query(`select fl_build_revert($1)`, [b1])), /отгружена|списана/); ok('сборку с отгруженным экземпляром не отменить')
assert.equal(await stock(), 90); ok('и склад при этом не вернулся')
const b2 = await buildSerial(2, ['FL-101', 'FL-102'])
await asAuth(u1, () => db.query(`select fl_build_revert($1)`, [b2]))
assert.deepEqual((await units()).map(u => u.serial), ['FL-001', 'FL-002', 'FL-003']); ok('отмена чистой сборки убирает её экземпляры')

console.log('добавить старый экземпляр вручную')
await asAuth(u1, () => db.query(`insert into fl_units (product_id, serial, note) values ($1, 'OLD-7', 'собран до системы')`, [prod]))
const old = await one(`select workspace_id, build_id, created_by from fl_units where serial = 'OLD-7'`)
assert.equal(old.workspace_id, ws); assert.equal(old.build_id, null); assert.equal(old.created_by, u1); ok('workspace проставлен, сборки нет')
await assert.rejects(asAuth(u1, () => db.query(`insert into fl_units (product_id, serial) values ($1, 'old-7')`, [prod])), /unique|duplicate/i); ok('дубль номера не пройдёт')
console.log('\nпроверки серийных номеров пройдены')

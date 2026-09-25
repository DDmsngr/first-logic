import assert from 'node:assert/strict'
import { boot } from './db.mjs'
process.on('unhandledRejection', e => { console.error('ОШИБКА:', e.message); process.exit(1) })

const db = await boot()
console.log('анонимный ключ и функции с правами владельца')
// Эти пускают без входа намеренно: приглашение по ссылке и служебные проверки,
// которые сами возвращают «нет» при auth.uid() = null.
const ALLOWED = new Set(['ws_invitation_preview', 'ws_register_via_invitation', 'ws_accept_invitation',
  'ws_is_member', 'ws_is_admin', 'ws_role', 'ws_task_ws', 'ws_can_read_conv', 'ws_conv_members', 'ws_touch',
  'ws_unread_counts', 'ws_mark_read', 'ws_open_direct', 'ws_create_group', 'ws_group_add_members', 'ws_claim_task',
  'ws_release_task', 'ws_import_tasks', 'ws_invite_member', 'ws_reissue_invitation', 'ws_sync_overdue',
  'fl_tg_create_link_code', 'fl_tg_unlink'])
const r = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
    and has_function_privilege('anon', p.oid, 'execute') order by 1`)
const open = r.rows.map(x => x.proname).filter(n => !ALLOWED.has(n))
assert.deepEqual(open, [], 'новые security definer функции доступны анонимно: ' + open.join(', '))
console.log('  ✓ новых функций, открытых анониму, нет')
await assert.rejects(db.exec(`set role anon; select fl_build(gen_random_uuid(), null, 1, '')`), /permission denied/)
await db.exec('reset role')
console.log('  ✓ fl_build без входа — permission denied')
console.log('\nпроверки прав пройдены')

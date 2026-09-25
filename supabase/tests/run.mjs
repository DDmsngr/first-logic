// Запускает все проверки базы по очереди; падение любой — код выхода 1.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let failed = 0
for (const f of fs.readdirSync(here).filter(f => f.endsWith('.check.mjs')).sort()) {
  console.log(`\n── ${f}`)
  try { execFileSync(process.execPath, [path.join(here, f)], { stdio: 'inherit' }) } catch { failed++ }
}
if (failed) { console.error(`\nпровалено проверок: ${failed}`); process.exit(1) }
console.log('\nвсе проверки базы пройдены')

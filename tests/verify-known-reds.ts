// 门禁归属: scripts/lib/known-reds.mts
import fs from 'node:fs'
import { loadKnownReds, classifyReds } from '../scripts/lib/known-reds.mts'
let failed = 0
function check(ok: boolean, msg: string): void { console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failed++ }
const accepted = loadKnownReds('tests/known-reds.json')
// 登记只会随修好的门禁一条条变短，所以不能再钉死一个总数（原先钉的 24 每修好一扇就红一次，#42）。
// 这里只守两件事：登记没被清空，也没比验收时的 24 条更长（新增一条已接受失败必须是有意的、要先改这里）。
check(accepted.size > 0 && accepted.size <= 24, 'register is not empty and never grows past the 24 accepted on 2026-11-16 (now ' + accepted.size + ')')
check([...accepted].every(f => fs.existsSync(f)), 'every accepted gate exists')
const out = classifyReds([{file:[...accepted][0], code:1}, {file:'tests/verify-new.ts', code:1}, {file:'tests/verify-green.ts', code:0}], accepted)
check(out.known.length === 1 && out.fresh.length === 1 && out.fresh[0].file === 'tests/verify-new.ts', 'unregistered red is classified as new')
const parallel = fs.readFileSync('scripts/verify-parallel.mts', 'utf8')
check(parallel.includes("process.exit(failed.length + smokeRedTotal ? 1 : 0)"), 'known reds still keep the old non-zero exit')
if (failed) process.exit(1)
console.log('all passed')

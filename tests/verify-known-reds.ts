// 门禁归属: scripts/lib/known-reds.mts
import fs from 'node:fs'
import { loadKnownReds, classifyReds } from '../scripts/lib/known-reds.mts'
let failed = 0
function check(ok: boolean, msg: string): void { console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failed++ }
const accepted = loadKnownReds('tests/known-reds.json')
// 登记只会随修好的门禁一条条变短，所以不能再钉死一个总数（原先钉的 24 每修好一扇就红一次，#42）。
// 登记的目标就是清空（#42 已清空）：空是合法的最终状态，这里只守它不会比验收时的 24 条更长
// （新增一条已接受失败必须是有意的、要先改这里）。
check(accepted.size <= 24, 'register never grows past the 24 accepted on 2026-11-16 (now ' + accepted.size + ')')
check([...accepted].every(f => fs.existsSync(f)), 'every accepted gate exists')
// 分类逻辑用自己的一份登记来测，不读真登记：真登记现在是空的，而且以后也应当是空的。
const sample = new Set(['tests/verify-registered.ts'])
const out = classifyReds([{file:'tests/verify-registered.ts', code:1}, {file:'tests/verify-new.ts', code:1}, {file:'tests/verify-green.ts', code:0}], sample)
check(out.known.length === 1 && out.known[0].file === 'tests/verify-registered.ts' && out.fresh.length === 1 && out.fresh[0].file === 'tests/verify-new.ts', 'registered red is known, unregistered red is classified as new, green is neither')
const emptyOut = classifyReds([{file:'tests/verify-new.ts', code:1}], new Set())
check(emptyOut.known.length === 0 && emptyOut.fresh.length === 1, 'with an empty register every red is new')
const parallel = fs.readFileSync('scripts/verify-parallel.mts', 'utf8')
check(parallel.includes("process.exit(failed.length + smokeRedTotal ? 1 : 0)"), 'known reds still keep the old non-zero exit')
if (failed) process.exit(1)
console.log('all passed')

// 门禁归属: scripts/lib/known-reds.mts
import fs from 'node:fs'
import { loadKnownReds, classifyReds } from '../scripts/lib/known-reds.mts'
let failed = 0
function check(ok: boolean, msg: string): void { console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failed++ }
const accepted = loadKnownReds('tests/known-reds.json')
check(accepted.size === 24, 'register lists 24 accepted failures')
check([...accepted].every(f => fs.existsSync(f)), 'every accepted gate exists')
const out = classifyReds([{file:[...accepted][0], code:1}, {file:'tests/verify-new.ts', code:1}, {file:'tests/verify-green.ts', code:0}], accepted)
check(out.known.length === 1 && out.fresh.length === 1 && out.fresh[0].file === 'tests/verify-new.ts', 'unregistered red is classified as new')
const parallel = fs.readFileSync('scripts/verify-parallel.mts', 'utf8')
check(parallel.includes("process.exit(failed.length + smokeRedTotal ? 1 : 0)"), 'known reds still keep the old non-zero exit')
if (failed) process.exit(1)
console.log('all passed')

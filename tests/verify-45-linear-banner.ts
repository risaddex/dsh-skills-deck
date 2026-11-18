// tests/verify-45-linear-banner.ts: a Linear workspace does not get the GitHub first-run banner (#45).
//
// Why this gate exists: with a Linear workspace the status bar showed "Environment status unavailable — re-check" and it never went
// away. The first-run guide list (GUIDE_STEPS) names only github, markdown and gitlab, so for `linear` the list is empty, and the
// banner code then fell back to GitHub's list "for a workspace that has not picked a backend yet". GitHub's list has a step that blocks
// set-up (`gh:remote`, "repository linked"), and the Linear check snapshot never contains it, so the code concluded the snapshot was
// incomplete and showed the neutral "could not read the environment" bar for ever (the host log said: reason missing-blocks-setup,
// decideStep gh:remote, backendId linear). The fallback is only meant for the case where no backend is chosen yet.
// 门禁归属: src/client/statusbar/bannerChain.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-linear-banner.ts
import { compileFn } from './lib/eval-probe.js'
import { spliceableJs } from './lib/source-text.ts'
import { printGateResult } from './lib/gate-result.ts'
import { guideStepsFor, guideStepDone, guideBannerOf, guideMissingOf } from '../src/shared/tracker/guide-steps.js'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }

const scope: Record<string, any> = { guideStepsFor, guideStepDone, guideBannerOf, guideMissingOf, dswsLogHash: (s: any) => 'h' + String(s || '').length, wsKeyOf: (x: any) => String(x || '') }
const names = Object.keys(scope)
const mod: any = compileFn(names, spliceableJs('src/client/statusbar/bannerChain.js') + '\nreturn { guideBannerDecision, guideBannerStep, guideBannerDiagnosis }').apply(null, names.map((k) => scope[k]))

const stOf = (backendId: string | null, steps: any[]): any => ({ cwd: '/ws', sessionId: 's', selection: backendId === null ? undefined : { backendId }, chainSnapshot: { steps } })
const row = (id: string, status = 'done'): any => ({ id, status })
// What the host sends for a Linear workspace today: the generic checks only, none of the GitHub or GitLab ones (6 rows in the log).
const LINEAR_ROWS = [row('env:home'), row('env:platform'), row('skill:wayfinder', 'pending'), row('skill:setup-matt-pocock-skills', 'pending'), row('skill:ask-matt', 'pending'), row('tracker:initialized', 'pending')]

// 1) the defect, as the log showed it
{
  check(guideStepsFor('linear').length === 0, 'the guide list has no steps of its own for linear (so the fallback is what decides)')
  const d: any = mod.guideBannerDecision(stOf('linear', LINEAR_ROWS), false)
  check(d.step === null, 'a Linear workspace gets no first-run banner from the GitHub list (got ' + JSON.stringify({ id: d.step && d.step.id, reason: d.reason, stepId: d.stepId }) + ')')
  check(d.reason !== 'missing-blocks-setup' && d.stepId !== 'gh:remote', 'and the decision never stops at the GitHub step gh:remote (reason ' + d.reason + ', step ' + d.stepId + ')')
  const diag: any = mod.guideBannerDiagnosis(stOf('linear', LINEAR_ROWS), false)
  check(diag.step === null && diag.meta === null, 'the diagnosis used by the status bar carries no banner either')
  const empty: any = mod.guideBannerDecision(stOf('linear', []), false)
  check(empty.step === null, 'with no snapshot rows yet it stays quiet too (reason ' + empty.reason + ')')
}

// 2) controls: the fallback is still there for the case it was written for, and the real backends are untouched
{
  const none: any = mod.guideBannerDecision(stOf(null, [row('selection:backendSelected', 'pending')]), true)
  check(none.step && none.step.id === 'selection:backendSelected' && none.reason === 'gate-open', 'control: no backend chosen yet still shows the "choose a backend" bar (got ' + JSON.stringify({ id: none.step && none.step.id, reason: none.reason }) + ')')
  const blank: any = mod.guideBannerDecision(stOf('', [row('selection:backendSelected', 'pending')]), true)
  check(blank.step && blank.step.id === 'selection:backendSelected', 'control: an empty backend id counts as not chosen')
  const stale = [row('tracker:initialized', 'pending'), row('skill:wayfinder', 'pending')]
  const gh: any = mod.guideBannerDecision(stOf('github', stale), false)
  check(gh.step && gh.step.id === 'chain:unread' && gh.reason === 'missing-blocks-setup', 'control: GitHub with a snapshot that lacks gh:remote still shows the neutral bar (the case that bar exists for)')
  const gl: any = mod.guideBannerDecision(stOf('gitlab', [row('glab:installed', 'pending')]), false)
  check(gl.step && gl.step.id === 'glab:installed', 'control: GitLab keeps its own list')
  const md: any = mod.guideBannerDecision(stOf('markdown', [row('tracker:initialized', 'pending'), row('skill:wayfinder', 'pending')]), false)
  check(md.step && md.step.id === 'tracker:initialized', 'control: Markdown keeps its own list')
  const unknown: any = mod.guideBannerDecision(stOf('some-future-backend', LINEAR_ROWS), false)
  check(unknown.step === null, 'a backend nobody wrote a guide list for gets no banner either, instead of borrowing GitHub\'s')
}
printGateResult('verify-45-linear-banner', assertions, failed)
if (failed) process.exit(1)

// tests/verify-65-linear-setup-hint.ts: a Linear workspace with no binding gets a setup hint, and the binding the hint leads to can be read back (#65, option C).
//
// Why this gate exists: in an empty repository with Linear chosen by hand, the panel showed only the snapshot error "this workspace has no Linear
// binding" and nothing else. #45 had removed the first-run guide for Linear (to stop a wrong yellow banner), so no banner, no button and no
// prompt existed, and nothing in the plugin could create the `# Issue tracker: linear` section the room needs.
// What this runs: the real banner decision (bannerChain.ts) over a Linear chain snapshot; the real guide list; the real binding predicate over a fake
// workspace file; the pure writer over four file states, each read back by the real parseBinding; and the host phone that builds the prompt, over a fake
// account seam that also carries token-like fields (only aliases may come out).
// 门禁归属: src/client/statusbar/bannerChain.ts
// 门禁归属: src/shared/tracker/guide-steps.ts
// 门禁归属: src/shared/tracker/check-catalog-dirs.ts
// 门禁归属: src/tracker/rooms/linear/binding-write.ts
// 门禁归属: src/tracker/rooms/linear/binding-check.ts
// 门禁归属: src/tracker/rooms/linear/binding-prompt.ts
// 门禁归属: src/refresh/rooms/host/linear-binding-phone.ts
// 门禁归属: src/tracker/registry/builtins.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-65-linear-setup-hint.ts
import fs from 'node:fs'
import path from 'node:path'
import { compileFn } from './lib/eval-probe.js'
import { spliceableJs } from './lib/source-text.ts'
import { printGateResult } from './lib/gate-result.ts'
import { guideStepsFor, guideStepDone, guideBannerOf, guideMissingOf, GUIDE_STEPS } from '../src/shared/tracker/guide-steps.js'
import { ALL_CATALOGS, catalogFor } from '../src/shared/tracker/check-catalog-dirs.js'
import { parseBinding } from '../src/tracker/rooms/linear/binding.js'

let assertions = 0
let failed = 0
const check = (ok: boolean, msg: string): void => { assertions += 1; if (!ok) failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }
const ROOT = path.resolve(import.meta.dirname, '..')

const scope: Record<string, any> = { guideStepsFor, guideStepDone, guideBannerOf, guideMissingOf, dswsLogHash: (s: any) => 'h' + String(s || '').length, wsKeyOf: (x: any) => String(x || '') }
const names = Object.keys(scope)
const mod: any = compileFn(names, spliceableJs('src/client/statusbar/bannerChain.js') + '\nreturn { guideBannerDecision, guideBannerDiagnosis }').apply(null, names.map((k) => scope[k]))
const stOf = (backendId: string, steps: any[]): any => ({ cwd: '/ws', sessionId: 's', selection: { backendId }, chainSnapshot: { steps } })
const row = (id: string, status = 'done'): any => ({ id, status })
// What the host sends for a Linear workspace: the generic checks plus the one Linear check of this ticket.
const rowsWith = (bindingStatus: string | null): any[] => [row('env:home'), row('skill:wayfinder', 'pending'), row('skill:setup-matt-pocock-skills', 'pending'), row('skill:ask-matt', 'pending'), row('tracker:initialized', 'pending')].concat(bindingStatus === null ? [] : [row('linear:binding', bindingStatus)])

async function main(): Promise<void> {
  // (a) the banner for a Linear workspace whose binding check is not done
  for (const status of ['pending', 'fail', 'current']) {
    const d: any = mod.guideBannerDecision(stOf('linear', rowsWith(status)), false)
    check(!!d.step && d.step.id === 'linear:binding' && d.reason === 'step-not-done', 'a: Linear with the binding row "' + status + '" shows the Linear setup banner (got ' + JSON.stringify({ id: d.step && d.step.id, reason: d.reason }) + ')')
    check(!(d.step && d.step.id === 'chain:unread') && d.reason !== 'missing-blocks-setup' && d.stepId !== 'gh:remote', 'a: and it is not the neutral bar of #45 nor the GitHub step (' + status + ')')
  }
  {
    const diag: any = mod.guideBannerDiagnosis(stOf('linear', rowsWith('pending')), false)
    check(!!diag.meta && diag.meta.text === 'banner.linearBinding' && diag.meta.btn === 'banner.linearBindingBtn', 'a: the status bar diagnosis carries the Linear banner text and button keys')
    const yaml = fs.readFileSync(path.join(ROOT, 'config/copy/panel.yaml'), 'utf8')
    const count = (key: string): number => yaml.split('\n').filter((l) => l.startsWith('  ' + key + ': ')).length
    check(count('banner.linearBinding') === 2 && count('banner.linearBindingBtn') === 2, 'a: both texts exist in the zh and the en block of config/copy/panel.yaml')
    check(count('setup.linear.trackerLine') === 2 && count('setup.linear.backendNote') === 2, 'a: the Linear setup description keys exist in both languages, so setupRun does not fall back to the GitHub text')
  }
  // (b) binding row done: no banner. And what makes the row done is the real predicate over a fake workspace file.
  {
    const d: any = mod.guideBannerDecision(stOf('linear', rowsWith('done')), false)
    check(d.step === null && d.reason === 'all-done', 'b: the binding row done means no banner (reason ' + d.reason + ')')
    const waiting: any = mod.guideBannerDecision(stOf('linear', []), false)
    check(waiting.step === null, 'b: no snapshot rows yet stays quiet')
    const checkMod: any = await import('../src/tracker/rooms/linear/binding-check.js').catch(() => null)
    check(!!checkMod && typeof checkMod.checkLinearBinding === 'function', 'b: the room exports the binding predicate')
    if (checkMod) {
      const platformOf = (doc: string | null): any => ({ fs: { resolve: async (rel: string, o: any) => (o && o.cwd ? o.cwd : '') + '/' + rel, readText: async () => { if (doc === null) throw new Error('ENOENT'); return doc } } })
      const run = async (doc: string | null): Promise<any> => checkMod.checkLinearBinding({ platform: platformOf(doc), cwd: '/ws', lang: 'en' })
      check((await run(null)).status === 'fail', 'b: no file -> the check fails')
      check((await run('# Issue tracker: github\n\nrepo: a/b\n')).status === 'fail', 'b: a GitHub-style file -> the check fails (the generic file-exists check would have said yes)')
      check((await run('# Issue tracker: linear\n\nteam: ENG\n')).status === 'fail', 'b: a Linear section without alias -> the check fails')
      const ok = await run('# Issue tracker: linear\n\nalias: work\n')
      check(ok.status === 'pass' && String(ok.detail).includes('work'), 'b: a valid section -> the check passes and names the alias')
      check((await checkMod.checkLinearBinding({ platform: null, cwd: '/ws', lang: 'en' })).status === 'pending', 'b: no file service at all -> pending, not fail')
    }
  }
  // (c) the guide lists
  {
    const ids = (b: string): string[] => guideStepsFor(b).map((s: any) => String(s.id))
    check(JSON.stringify(ids('github')) === JSON.stringify(['selection:backendSelected', 'gh:installed', 'gh:authed', 'gh:remote', 'tracker:initialized', 'skill:wayfinder']), 'c: the GitHub list is unchanged')
    check(JSON.stringify(ids('gitlab')) === JSON.stringify(['selection:backendSelected', 'glab:installed', 'glab:authed', 'glab:repoAccess', 'tracker:initialized', 'skill:wayfinder']), 'c: the GitLab list is unchanged')
    check(JSON.stringify(ids('markdown')) === JSON.stringify(['selection:backendSelected', 'tracker:initialized', 'skill:wayfinder']), 'c: the local Markdown list is unchanged')
    check(JSON.stringify(ids('linear')) === JSON.stringify(['linear:binding']), 'c: the Linear list is exactly the one new step, with no generic skill step and no tracker:initialized')
    check(guideStepsFor('some-future-backend').length === 0 && guideStepsFor('').length === 0, 'c: an unknown or empty backend still has no list')
    const step: any = guideStepsFor('linear')[0] || {}
    check(step.ready === 'chain' && step.blocksSetup === false && JSON.stringify(step.checks) === JSON.stringify(['linear:binding']), 'c: the step reads the chain snapshot and does not block set-up')
    check(!!step.missing && step.missing.type === 'host-prompt' && step.missing.method === 'wf.linearBindingPrompt', 'c: the button asks the host for a built prompt, not the generic setupRun text')
    check(GUIDE_STEPS.filter((s: any) => s.id !== 'linear:binding').every((s: any) => s.backends.indexOf('linear') < 0), 'c: no existing step lists linear in its backends')
    const linearItems = catalogFor('linear').filter((c: any) => c.scope === 'backend').map((c: any) => String(c.id))
    check(JSON.stringify(linearItems) === JSON.stringify(['linear:binding']) && (ALL_CATALOGS as any).linear.length === 1, 'c: the check catalog has one Linear backend check, with the id the step reads')
    check(catalogFor('github').every((c: any) => c.id !== 'linear:binding') && catalogFor('markdown').every((c: any) => c.id !== 'linear:binding'), 'c: other backends do not get the Linear check')
  }
  // (d) the pure writer
  const w: any = await import('../src/tracker/rooms/linear/binding-write.js').catch(() => null)
  check(!!w && typeof w.renderBindingSection === 'function' && typeof w.mergeBinding === 'function', 'd: the room exports renderBindingSection and mergeBinding')
  if (w) {
    const section = w.renderBindingSection({ alias: 'work' })
    check(section === '# Issue tracker: linear\n\nalias: work\n', 'd: alias only renders the heading and one line (got ' + JSON.stringify(section) + ')')
    const full = w.renderBindingSection({ alias: 'work', team: 'ENG', project: 'Deck' })
    check(full === '# Issue tracker: linear\n\nalias: work\nteam: ENG\nproject: Deck\n', 'd: team and project render only when given')
    check(w.renderBindingSection({ alias: 'work', team: '  ', project: '' }) === section, 'd: blank optional values are omitted, not written as empty lines')
    let threw = 0
    for (const bad of [{ alias: '' }, { alias: 'Bad Alias' }, { alias: 'a\nb' }, { alias: 'work', team: 'EN\nG' }, { alias: 'work', project: 'x\ny' }]) { try { w.renderBindingSection(bad); } catch { threw += 1 } }
    check(threw === 5, 'd: an empty alias, an alias outside the account-name pattern and multi-line values are refused')
    const other = '# Issue tracker: GitHub\n\nSome words.\n\n## Triage labels\n\n- needs-triage\n'
    const cases: Array<[string, string | null, (out: string) => boolean]> = [
      ['no file', null, (out) => out === section],
      ['a file without a Linear section (appended, the rest byte-identical)', other, (out) => out.startsWith(other) && out.slice(other.length) === '\n' + section],
      ['the same file without a final newline', other.replace(/\n$/, ''), (out) => out.startsWith(other.replace(/\n$/, '')) && parseBinding(out) !== null],
      ['a Linear section without alias (only that section replaced)', '# Intro\n\nHello\n\n# Issue tracker: linear\n\nteam: ENG\nproject: (optional)\n\n## After\n\nTail\n', (out) => out.startsWith('# Intro\n\nHello\n\n') && out.endsWith('\n## After\n\nTail\n') && !out.includes('(optional)') && !out.includes('team: ENG')],
      ['a Linear section with another alias at the end of the file', '# Intro\n\nHello\n\n# Issue tracker: linear\n\nalias: old\n', (out) => out.startsWith('# Intro\n\nHello\n\n') && !out.includes('old')],
      ['a file with other sections on both sides', '# A\n\na\n\n# Issue tracker: Linear\n\nalias: old\n\n# B\n\nb\n', (out) => out.startsWith('# A\n\na\n\n') && out.endsWith('# B\n\nb\n') && !out.includes('old')],
      ['CRLF line endings', '# A\r\n\r\na\r\n', (out) => out.startsWith('# A\r\n\r\na\r\n') && out.includes('alias: work\r\n') && !/[^\r]\n/.test(out.slice('# A\r\n\r\na\r\n'.length))],
    ]
    for (const [label, existing, extra] of cases) {
      let out = ''
      try { out = w.mergeBinding(existing, section) } catch (e: any) { out = 'THROWN ' + String(e && e.message) }
      const bound = parseBinding(out)
      check(!!bound && bound.alias === 'work', 'd: ' + label + ' -> read back by parseBinding gives the chosen alias')
      check(extra(out) && !out.includes('(optional)') && !out.includes('THROWN'), 'd: ' + label + ' -> content outside the section kept, no "(optional)" text')
    }
    const withTeam = w.mergeBinding('# X\n\nx\n', w.renderBindingSection({ alias: 'work', team: 'ENG', project: 'Deck' }))
    const b2 = parseBinding(withTeam)
    check(!!b2 && b2.alias === 'work' && b2.team === 'ENG' && b2.project === 'Deck', 'd: team and project are read back too')
    const once = w.mergeBinding(other, section)
    check(w.mergeBinding(once, section) === once, 'd: merging the same section twice changes nothing (idempotent)')
  }
  // (e) where the aliases come from and what leaves the host
  const phone: any = await import('../src/refresh/rooms/host/linear-binding-phone.js').catch(() => null)
  check(!!phone && typeof phone.createLinearBindingPhone === 'function', 'e: the host exports the prompt phone')
  if (phone) {
    const SECRET = 'lin_api_SECRETSECRET1234567890'
    const rec = (alias: string, extra: Record<string, unknown> = {}): any => ({ alias, label: alias.toUpperCase(), teams: ['ENG'], reviewPattern: 'review', reviewScope: 'subscribed', ...extra })
    const seamOf = (result: any): any => ({ resolve: async () => { throw new Error('resolve must not be called') }, list: async () => result })
    const extras = (): Promise<any> => import('../src/tracker/rooms/linear/binding-prompt.js')
    const run = async (result: any, lang = 'en'): Promise<any> => phone.createLinearBindingPhone({ seam: () => seamOf(result), extras }).handle({ lang })
    const section = (a: string): string => '# Issue tracker: linear\n\nalias: ' + a + '\n'
    const two = await run({ ok: true, accounts: [rec('work', { token: SECRET, authorization: 'Bearer ' + SECRET, refreshToken: SECRET, clientSecret: SECRET }), rec('home')] })
    const dump = JSON.stringify(two)
    check(two.ok === true && JSON.stringify(two.aliases.map((a: any) => a.alias)) === JSON.stringify(['work', 'home']), 'e: two aliases are listed, aliases only (' + JSON.stringify(two.aliases) + ')')
    check(!dump.includes(SECRET) && !/Bearer|lin_api_|clientSecret|refreshToken|authorization|reviewPattern/i.test(dump), 'e: nothing token-like and no extra field appears anywhere in the phone output')
    check(Object.keys(two.aliases[0]).sort().join(',') === 'alias,label,teams', 'e: only alias, label and teams cross the boundary')
    check(/ask the maintainer/i.test(two.text) && two.text.includes('work') && two.text.includes('home') && !two.text.includes('alias: work\n'), 'e: with two aliases the prompt lists both and tells the agent to ask the maintainer, with no alias chosen for them')
    check(two.text.includes('docs/agents/issue-tracker.md') && /create .*docs\/agents/i.test(two.text) && /read .* back|re-read/i.test(two.text), 'e: the prompt names the file, the case where it does not exist, and the read-back')
    check(!/\/setup-matt-pocock-skills/.test(two.text) && !/github/i.test(two.text), 'e: the prompt neither starts the generic setup skill nor mentions GitHub')
    const one = await run({ ok: true, accounts: [rec('work', { token: SECRET })] })
    check(one.text.includes(section('work')) && !/ask the maintainer which alias/i.test(one.text) && !one.text.includes(SECRET), 'e: with one alias the prompt carries the exact section text for that alias and proposes it')
    check(/verbatim|exactly/i.test(one.text) && /do not (rewrite|reformat|change)|keep every other/i.test(one.text), 'e: the prompt asks for the exact text and for the rest of the file to be left alone')
    const none = await run({ ok: true, accounts: [] })
    check(none.ok === true && none.aliases.length === 0 && /ask the maintainer/i.test(none.text) && /no (Linear )?account/i.test(none.text), 'e: with no configured account the prompt says so and tells the agent to ask the maintainer')
    const failure = await run({ ok: false, status: 'error', message: 'cannot read ' + SECRET })
    check(failure.ok === true && !JSON.stringify(failure).includes(SECRET) && /ask the maintainer/i.test(failure.text), 'e: a seam failure is turned into the "ask the maintainer" prompt, and its message text is dropped')
    const thrown = await phone.createLinearBindingPhone({ seam: () => ({ list: async () => { throw new Error(SECRET) } }), extras }).handle({ lang: 'en' })
    check(!JSON.stringify(thrown).includes(SECRET) && typeof thrown.text === 'string' && thrown.text.length > 0, 'e: a seam that throws does not leak its error text either')
    const noSeam = await phone.createLinearBindingPhone({ seam: () => null, extras }).handle({ lang: 'en' })
    check(typeof noSeam.text === 'string' && /ask the maintainer/i.test(noSeam.text), 'e: no seam wired -> still the "ask the maintainer" prompt')
    const zh = await run({ ok: true, accounts: [rec('work')] }, 'zh')
    check(zh.text.includes(section('work')) && /[\u4e00-\u9fff]/.test(zh.text), 'e: the Chinese prompt carries the same exact section text')
    const weird = await run({ ok: true, accounts: [rec('work'), rec('Bad Alias'), { nope: 1 }, rec('work')] })
    check(JSON.stringify(weird.aliases.map((a: any) => a.alias)) === JSON.stringify(['work']), 'e: entries without a usable alias, with a bad alias or duplicated are dropped, not guessed')
  }
  printGateResult('verify-65-linear-setup-hint', assertions, failed)
  if (failed) process.exit(1)
}
main().catch((e) => { console.log('  FAIL gate crashed: ' + String((e && e.stack) || e)); printGateResult('verify-65-linear-setup-hint', assertions, failed + 1); process.exit(1) })

// tests/verify-12-linear-accounts.ts — the Linear account metadata file (#12, map ticket)
// Pins the behaviour a person relies on when editing ~/.dsh/mattskillsdeck/linear-accounts.yaml:
//   L1  round trip: what is written reads back unchanged.
//   L2  an unusable alias is refused, with the rule in the message.
//   L3  two accounts may not share an alias (references start with it).
//   L4  two accounts may not pin one Linear organization.
//   L5  an unknown account field is refused and named (silently dropping it loses the user's data).
//   L6  an unknown top-level field is refused and named.
//   L7  team keys are uppercased and deduplicated.
//   L8  a defaultAccount that names nothing is cleared with a warning, not refused.
//   L9  an expired previous alias is dropped with a warning; a live one is kept.
//   L10 an unusable review-state pattern is refused (it is a regular expression).
//   L11 reviewScope and authType accept only their documented names.
//   L12 a newer version is read-only, an unknown version is a bad shape.
// Usage: node --import ./scripts/ts-hook.mts tests/verify-12-linear-accounts.ts
const path = require('path')
const { pathToFileURL } = require('url')

const ROOT: string = path.resolve(__dirname, '..')
let failed = false
let total = 0
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 300) : '')))
  if (!ok) failed = true
}

const one = {
  alias: 'ombrello',
  label: 'Ombrello',
  authType: 'api_key',
  orgId: 'org-1',
  urlKey: 'ombrello',
  teams: ['ENG'],
  reviewPattern: 'review|qa',
  reviewScope: 'team',
  previousAliases: [{ alias: 'omb', until: '2999-01-01' }],
}

function account(over: Record<string, unknown>): Record<string, unknown> {
  return Object.assign({}, one, over)
}

function doc(accounts: unknown[], extra?: Record<string, unknown>): Record<string, unknown> {
  return Object.assign({ version: 1, defaultAccount: '', accounts }, extra || {})
}

async function main() {
  console.log('Linear account metadata gate (#12)')
  const core = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'configStore.js')).href)
  const { parseConfig, stringifyConfig } = core

  // —— L1: round trip ——
  {
    const value = doc([one], { defaultAccount: 'ombrello' })
    const out = stringifyConfig(value, 'linear-accounts')
    check(out.ok === true, 'L1 writes the file', out.ok ? '' : out.message)
    const back = out.ok ? parseConfig(out.text, 'linear-accounts') : null
    check(!!back && back.ok === true && JSON.stringify(back.value) === JSON.stringify(value), 'L1 round trip leaves every field unchanged', JSON.stringify(back && back.value))
    check(out.ok && /^# Comments in this file are generated/.test(out.text) && /holds no secret/.test(out.text), 'L1 the written file explains itself and promises no secret')
    const empty = stringifyConfig(doc([]), 'linear-accounts')
    const emptyBack = empty.ok ? parseConfig(empty.text, 'linear-accounts') : null
    check(!!emptyBack && emptyBack.ok === true && emptyBack.value.accounts.length === 0, 'L1 an account-less file reads back as an empty list', JSON.stringify(emptyBack && emptyBack.value))
  }

  // —— L2..L6: refusals ——
  {
    const upper = parseConfig('version: 1\naccounts:\n  - alias: Ombrello\n', 'linear-accounts')
    check(upper.ok === true && upper.value.accounts[0].alias === 'ombrello', 'L2 a mixed-case alias is normalized to lowercase', JSON.stringify(upper))

    const direct = parseConfig('version: 1\naccounts:\n  - alias: "o"\n', 'linear-accounts')
    check(direct.ok === false && /alias/.test(direct.message), 'L2 a one-character alias is refused and the rule is stated', JSON.stringify(direct))

    const dupAlias = parseConfig('version: 1\naccounts:\n  - alias: alpha\n  - alias: alpha\n', 'linear-accounts')
    check(dupAlias.ok === false && /unique|two accounts/.test(dupAlias.message), 'L3 a duplicate alias is refused', JSON.stringify(dupAlias))

    const dupOrg = parseConfig('version: 1\naccounts:\n  - alias: alpha\n    orgId: org-1\n  - alias: beta\n    orgId: org-1\n', 'linear-accounts')
    check(dupOrg.ok === false && /organization/.test(dupOrg.message), 'L4 two accounts pinning one organization are refused', JSON.stringify(dupOrg))

    const strange = parseConfig('version: 1\naccounts:\n  - alias: alpha\n    colour: blue\n', 'linear-accounts')
    check(strange.ok === false && strange.reason === 'unknown-keys' && Array.isArray(strange.keys) && strange.keys.indexOf('colour') >= 0, 'L5 an unknown account field is refused and named', JSON.stringify(strange))

    const strangeTop = parseConfig('version: 1\naccounts: []\nworkspace: x\n', 'linear-accounts')
    check(strangeTop.ok === false && strangeTop.reason === 'unknown-keys', 'L6 an unknown top-level field is refused', JSON.stringify(strangeTop))
  }

  // —— L7..L9: normalization instead of refusal ——
  {
    const teams = parseConfig('version: 1\naccounts:\n  - alias: alpha\n    teams: [eng, ENG, ops, ""]\n', 'linear-accounts')
    check(teams.ok === true && JSON.stringify(teams.value.accounts[0].teams) === JSON.stringify(['ENG', 'OPS']), 'L7 team keys are uppercased and deduplicated', JSON.stringify(teams.ok ? teams.value.accounts[0].teams : teams))

    const label = parseConfig('version: 1\naccounts:\n  - alias: alpha\n', 'linear-accounts')
    check(label.ok === true && label.value.accounts[0].label === 'alpha' && label.value.accounts[0].authType === 'api_key' && label.value.accounts[0].reviewScope === 'subscribed', 'L7 missing fields take their documented defaults', JSON.stringify(label.ok ? label.value.accounts[0] : label))

    const defaultUnknown = parseConfig('version: 1\ndefaultAccount: ghost\naccounts:\n  - alias: alpha\n', 'linear-accounts')
    check(defaultUnknown.ok === true && defaultUnknown.value.defaultAccount === '' && defaultUnknown.warnings.length > 0, 'L8 an unknown default is cleared with a warning', JSON.stringify(defaultUnknown))

    const previous = parseConfig('version: 1\naccounts:\n  - alias: alpha\n    previousAliases:\n      - alias: gone\n        until: 2000-01-01\n      - alias: live\n        until: 2999-01-01\n', 'linear-accounts')
    check(previous.ok === true && previous.value.accounts[0].previousAliases.length === 1 && previous.value.accounts[0].previousAliases[0].alias === 'live' && previous.warnings.length > 0, 'L9 an expired previous alias is dropped with a warning; the live one stays', JSON.stringify(previous.ok ? previous.value.accounts[0].previousAliases : previous))
  }

  // —— L10..L12: the remaining refusals ——
  {
    const badPattern = parseConfig('version: 1\naccounts:\n  - alias: alpha\n    reviewPattern: "[unclosed"\n', 'linear-accounts')
    check(badPattern.ok === false && /regular expression/.test(badPattern.message), 'L10 an unusable review-state pattern is refused', JSON.stringify(badPattern))

    const badScope = parseConfig('version: 1\naccounts:\n  - alias: alpha\n    reviewScope: everything\n', 'linear-accounts')
    check(badScope.ok === false && /reviewScope/.test(badScope.message), 'L11 an unknown reviewScope is refused', JSON.stringify(badScope))

    const badAuth = parseConfig('version: 1\naccounts:\n  - alias: alpha\n    authType: password\n', 'linear-accounts')
    check(badAuth.ok === false && /authType/.test(badAuth.message), 'L11 an unknown authType is refused', JSON.stringify(badAuth))

    const newer = parseConfig('version: 2\naccounts: []\n', 'linear-accounts')
    check(newer.ok === true && newer.readonly === true && newer.warnings.length > 0, 'L12 a newer version is readable but read-only', JSON.stringify(newer))

    const wrongVersion = parseConfig('version: 0\naccounts: []\n', 'linear-accounts')
    check(wrongVersion.ok === false && wrongVersion.reason === 'bad-shape', 'L12 an unknown version is a bad shape', JSON.stringify(wrongVersion))
  }

  console.log('\n' + (total - (failed ? 1 : 0)) + '/' + total + ' checks passed' + (failed ? ' — SOME FAILED' : ' — OK'))
  process.exit(failed ? 1 : 0)
}

main().catch((e: unknown) => {
  console.error('gate crashed:', e)
  process.exit(1)
})

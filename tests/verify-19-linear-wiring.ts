// tests/verify-19-linear-wiring.ts — which accounts get a sign-in flow (#19, map ticket), fully offline
//   W1  a missing accounts file registers nothing and says so; it is not an error.
//   W2  an unparseable accounts file registers nothing and reports why, instead of half-registering.
//   W3  only OAuth accounts get a flow; api_key accounts get none.
//   W4  no authorization seam registers nothing and says so.
//   W5  the disposer withdraws every flow it registered.
//   W6  the registry override variable is honoured.
// Usage: node --import ./scripts/ts-hook.mts tests/verify-19-linear-wiring.ts
const path = require('path')
const { pathToFileURL } = require('url')
const ROOT: string = path.resolve(__dirname, '..')
let failed = false
const check = (ok: boolean, msg: string, detail?: unknown): void => {
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok ? '' : (detail ? ' — ' + String(detail).slice(0, 300) : '')))
  if (!ok) failed = true
}
const YAML = (accounts: string) => 'version: 1\ndefaultAccount: ""\naccounts:\n' + accounts
const ACC = (alias: string, auth: string) => '  - alias: ' + alias + '\n    label: ' + alias + '\n    authType: ' + auth + '\n    orgId: ""\n    urlKey: ""\n    teams: []\n    reviewPattern: review\n    reviewScope: subscribed\n    previousAliases: []\n'
function ioWith(files: Record<string, string>) {
  return { readText: async (p: string) => { if (p in files) return files[p]; const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e }, writeText: async () => {} }
}
function seamCtx() {
  const registered: any[] = []; const disposed: string[] = []
  return { registered, disposed, ctx: { get: (n: string) => (n === 'authorization' ? { registerFlow: (f: any) => { registered.push(f); return () => { disposed.push(f.key) } } } : null) } }
}

async function main() {
  console.log('Linear sign-in wiring gate (#19)')
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'linearSigninWiring.js')).href)
  const HOME = '/home/x'
  const FILE = HOME + '/.dsh/mattskillsdeck/linear-accounts.yaml'

  { const s = seamCtx(); const r = await mod.wireLinearSignin({ ctx: s.ctx, homeDir: HOME, io: ioWith({}) })
    check(r.registered === 0 && r.skipped === 'no_accounts_file' && s.registered.length === 0, 'W1 a missing file registers nothing and is not an error', JSON.stringify(r)) }

  { const s = seamCtx(); const r = await mod.wireLinearSignin({ ctx: s.ctx, homeDir: HOME, io: ioWith({ [FILE]: 'version: [unclosed' }) })
    check(r.registered === 0 && r.skipped === 'unreadable' && s.registered.length === 0, 'W2 an unparseable file registers nothing and says why', JSON.stringify(r)) }

  { const s = seamCtx(); const io = ioWith({ [FILE]: YAML(ACC('ombrello', 'oauth_app') + ACC('work', 'api_key') + ACC('two', 'oauth_user')) })
    const r = await mod.wireLinearSignin({ ctx: s.ctx, homeDir: HOME, io })
    check(r.registered === 2 && s.registered.map((f: any) => f.key).join(',') === 'skills-deck/linear-ombrello,skills-deck/linear-two', 'W3 only OAuth accounts get a flow', JSON.stringify(r) + ' ' + s.registered.map((f: any) => f.key))
    r.dispose()
    check(s.disposed.length === 2, 'W5 the disposer withdraws every flow it registered', s.disposed.join(',')) }

  { const io = ioWith({ [FILE]: YAML(ACC('api', 'api_key')) }); const s = seamCtx()
    const r = await mod.wireLinearSignin({ ctx: s.ctx, homeDir: HOME, io })
    check(r.skipped === 'no_oauth_accounts' && s.registered.length === 0, 'W3 an api_key-only file registers nothing', JSON.stringify(r)) }

  { const io = ioWith({ [FILE]: YAML(ACC('ombrello', 'oauth_app')) })
    const r = await mod.wireLinearSignin({ ctx: { get: () => null }, homeDir: HOME, io })
    check(r.registered === 0 && r.skipped === 'no_seam', 'W4 no authorization seam registers nothing and says so', JSON.stringify(r)) }

  { const s = seamCtx(); const io = ioWith({ '/etc/shared.yaml': YAML(ACC('shared', 'oauth_app')) })
    const r = await mod.wireLinearSignin({ ctx: s.ctx, homeDir: HOME, io, env: (n: string) => (n === 'DSH_DECK_LINEAR_REGISTRY' ? '/etc/shared.yaml' : undefined) })
    check(r.registered === 1 && s.registered[0].key === 'skills-deck/linear-shared', 'W6 the registry override variable is honoured', JSON.stringify(r)) }

  { const os = require('os'); const fs = require('fs'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-'))
    try {
      const io = mod.nodeFileIo(); const f = path.join(dir, 'a.yaml'); fs.writeFileSync(f, 'hello')
      check((await io.readText(f)) === 'hello', 'W7 the default io reads a real file')
      let code = ''; try { await io.readText(path.join(dir, 'nope.yaml')) } catch (e: any) { code = String(e.code) }
      check(code === 'ENOENT', 'W7 a missing file fails as ENOENT', code)
      const s = seamCtx(); fs.mkdirSync(path.join(dir, '.dsh', 'mattskillsdeck'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.dsh', 'mattskillsdeck', 'linear-accounts.yaml'), YAML(ACC('ombrello', 'oauth_app')))
      const r = await mod.wireLinearSignin({ ctx: s.ctx, homeDir: dir, io })
      check(r.registered === 1, 'W7 end to end over a real file on disk', JSON.stringify(r))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) } }

  if (failed) { console.log('\nFAILED'); process.exit(1) }
  console.log('\nOK')
}
main().catch((e) => { console.error(e); process.exit(1) })

/**
 * tests/lib/prompt-overrides-env.ts —— 提示词改写两扇门禁（#100）共用的夹具。
 *
 * 为什么单独一份：两扇门禁都要「按构建同一次序拼客户端那几片、再接上宿主真实现的两条设置电话」，
 * 这套搭建约一百行，各写一遍改一处要改两处；收在这里，门禁只管断言。
 * 真件与替身的分界与 tests/verify-settings-templates.ts 一致：宿主的设置电话与配置适配器是真实现，读写落在临时目录的真文件上；
 * 只有手机（假 host 的 call）、内存里的 localStorage 与可以按需制造写失败的文件包装是替身。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { spawnSync } = require('child_process')
const realFs = require('node:fs/promises')
const { compileFn } = require('./eval-probe.ts')
const { spliceableJs } = require('./source-text.ts')
const { promptDataSpliceable } = require('./prompt-data.ts')
const { installTimeCompression } = require('./time-compress.ts')
installTimeCompression()


const ROOT = path.resolve(__dirname, '..', '..')
const readText = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const settingsPathIn = (home: string): string => path.join(home, '.dsh', 'mattskillsdeck', 'settings.yaml')
const centralTime = require('../../src/shared/time-config/values.js')
;(globalThis as any).VIEW_FLAG_WRITE_DEBOUNCE_MS = centralTime.VIEW_FLAG_WRITE_DEBOUNCE_MS

const realIo = {
  readText: (p: string) => realFs.readFile(String(p), 'utf8'),
  writeText: (p: string, t: string) => realFs.writeFile(String(p), String(t), 'utf8'),
  mkdir: (p: string) => realFs.mkdir(String(p), { recursive: true }),
  rm: (p: string) => realFs.unlink(String(p)),
}
function wrapSysFs(overrides?: any): any {
  return {
    async readFile(p: string, enc: string) { return realFs.readFile(p, enc) },
    async writeFile(p: string, text: string, enc: string) { if (overrides && overrides.writeFile) return overrides.writeFile(p, text, enc); return realFs.writeFile(p, text, enc) },
    async mkdir(p: string, opts: any) { return realFs.mkdir(p, opts) },
    async unlink(p: string) { return realFs.unlink(p) },
  }
}
function makeHost(phones: any, calls: any[]): any {
  return {
    call: function (method: string, args: any) {
      calls.push({ method: method, args: args })
      if (method === 'wf.getSettings') return phones.handleGetSettings(args || {})
      if (method === 'wf.setSettings') return phones.handleSetSettings(args || {})
      return Promise.resolve({ ok: false, error: { kind: 'environment', message: 'no such phone' } })
    },
  }
}
function makeLocalStorage(initial?: any): any {
  const m: any = Object.assign({}, initial || {})
  return {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(m, k) ? String(m[k]) : null),
    setItem: (k: string, v: any) => { m[k] = String(v) },
    removeItem: (k: string) => { delete m[k] },
  }
}
const noExport = (s: string): string => s.replace(/^\s*export\s+/gm, '')

// 被测那几片，按 scripts/build.mts 的次序拼：提示词数据 → 旧模板读口 → 提示词取用口（含按后端渲染）→ 设置文档四片 → 本片。
const FRAGMENTS_BASE = [
  'src/client/kernel/config.ts',
  'src/client/kernel/prompts.ts',
  'src/client/kernel/prompts-backend.ts',
  'src/client/kernel/settings-view-state.ts',
  'src/client/kernel/settings-view.ts',
  'src/client/kernel/settings-view-write.ts',
  'src/client/kernel/settings-view-reload.ts',
]
const OVERRIDES_REL = 'src/client/kernel/settings-prompt-overrides.ts'
const TAIL_COMMON = 'viewFlagState: viewFlagState, settingsViewLoad: settingsViewLoad, viewFlagReadyNow: viewFlagReadyNow, promptText: promptText, promptTextFor: promptTextFor, tplText: tplText, templates: templates, PROMPTS: PROMPTS, VIEW_FLAG_WRITE_DEBOUNCE_MS: VIEW_FLAG_WRITE_DEBOUNCE_MS'
const TAIL_OVERRIDES = ', PROMPT_OVERRIDE_IDS: PROMPT_OVERRIDE_IDS, promptOverrideOf: promptOverrideOf, promptOverrideStoredOf: promptOverrideStoredOf, promptOverrideDefaultOf: promptOverrideDefaultOf, promptOverrideHelpOf: promptOverrideHelpOf, promptOverrideCheck: promptOverrideCheck, setPromptOverride: setPromptOverride'
const NAMES = ['keyOf', 'wsKeyOf', 'shared', 'stores', 'emit', 'host', 'localStorage', 'log', 'dswsLogHash', 'timer', 'currentOs', 'workspaceRootByCwd', 'localeSvc', 'issueUrlFor']

function makeClient(env: any, withOverrides: boolean): any {
  const rels = FRAGMENTS_BASE.concat(withOverrides ? [OVERRIDES_REL] : [])
  const body = [promptDataSpliceable(ROOT)].concat(rels.map((r) => spliceableJs(r))).join('\n')
  const tail = '\nreturn { ' + TAIL_COMMON + (withOverrides ? TAIL_OVERRIDES : '') + ' }'
  return compileFn(NAMES, body + tail).apply(null, NAMES.map((n) => env[n]))
}

/** 搭好一个场景要用的全部东西：先构建（运行时形状来自拼接），再取宿主真件，返回造场景的工厂与几个等待工具。 */
async function setup(): Promise<any> {
  const built = spawnSync(process.execPath, [path.join('scripts', 'build.mts')], { cwd: ROOT, stdio: 'inherit' })
  const leaf = await import(pathToFileURL(path.join(ROOT, 'src/host', 'settingsPhones.js')).href)
  const store = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'configStore.js')).href)
  const core = await import(pathToFileURL(path.join(ROOT, 'src/shared/config-store/src/settings.js')).href)
  const KEY_SRC = readText('.build/shared/workspaceKey.js').replace(/^\s*export\s+/gm, '')
  const KEY_OF = compileFn([], KEY_SRC + '\nreturn keyOf')()
  const CURRENT_OS = compileFn([], KEY_SRC + '\nreturn currentOs')()

  function makeEnv(opts?: any): any {
    const o = opts || {}
    const home = o.home || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-po-' + (o.tag || 'case') + '-'))
    const ls = makeLocalStorage(o.localStorage)
    const phones = leaf.createSettingsPhones({
      getPlatform: async () => ({ getHome: async () => home }),
      readLocalSettings: store.readLocalSettings,
      writeLocalSettings: store.writeLocalSettings,
      fs: wrapSysFs(o.fsOverrides || null),
      logCtx: null,
    })
    const calls: any[] = []
    const logs: any[] = []
    const envObj = {
      keyOf: KEY_OF, wsKeyOf: (c: string) => KEY_OF(c) || '', workspaceRootByCwd: {}, shared: null, stores: {}, emit: () => {},
      host: makeHost(phones, calls), localStorage: ls,
      log: (level: string, event: string, fields: any) => { logs.push({ level, event, fields }) },
      dswsLogHash: (s: string) => 'h' + String(s || '').length,
      timer: undefined, currentOs: CURRENT_OS,
      localeSvc: { getSnapshot: () => ({ active: 'zh' }) },
      issueUrlFor: (_st: any, num: any) => 'https://example.invalid/' + String(num),
    }
    return { mod: makeClient(envObj, true), base: makeClient(envObj, false), ls, calls, logs, home, envObj }
  }
  async function readDoc(home: string): Promise<any> {
    if (!fs.existsSync(settingsPathIn(home))) return null
    const r = await store.readLocalSettings(home, realIo)
    return (r && r.ok === true) ? r.value : null
  }
  async function waitFor(fn: () => any, capMs?: number): Promise<boolean> {
    const t0 = Date.now()
    for (;;) {
      let hit = false
      try { hit = !!(await fn()) } catch (e) { hit = false }
      if (hit) return true
      if (Date.now() - t0 > (capMs || 8000)) return false
      await sleep(25)
    }
  }
  const ready = (env: any): Promise<boolean> => waitFor(async () => env.mod.viewFlagReadyNow() === true)
  const PARAMS = { n: '7', title: 'T', url: 'https://example.invalid/7' }
  return { buildStatus: built.status, leaf, store, core, makeEnv, readDoc, waitFor, ready, PARAMS }
}

module.exports = { ROOT, readText, sleep, settingsPathIn, realIo, noExport, OVERRIDES_REL, setup }

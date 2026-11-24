#!/usr/bin/env node
/**
 * verify-100-prompt-overrides-rules.ts —— 提示词改写门禁之二（#100）。
 *
 * 第五件事是校验：未知占位符、丢了 {url}、空白文字各按约定处理，被拒的一个字都不写进文件。
 * 第六件事是手改文件造出的坏值不生效：按钮仍用默认文本，不会注入一段没有链接的提示词。
 * 第七件事是旧模板老文本不挡新改写：旧的 templates 节还留着老文本时，同一个按钮的改写赢；没有改写时旧行为一字不变。
 * 第八件事是写不进文件时的底线：文件是更高版本就拒绝且不改一个字节；写失败时本次会话内改写仍生效；文档在路上时先记着。
 * 第九件事是接线与行数：构建清单与客户端入口登记了这一片、设置页挂了这一组、新文件没有超三百五十有效行。
 * 怎么保证量的是真件见 tests/verify-100-prompt-overrides.ts 与夹具 tests/lib/prompt-overrides-env.ts。
 *
 * 用法：node --import ./scripts/ts-hook.mts tests/verify-100-prompt-overrides-rules.ts（在插件根目录；本脚本自己会先构建）
 */
const fs = require('fs')
const path = require('path')
const { countEffectiveLines } = require('../scripts/lib/effective-lines.mts')
const { sourcePath } = require('./lib/source-text.ts')
const { printGateResult } = require('./lib/gate-result.ts')
const { ROOT, readText, sleep, settingsPathIn, realIo, noExport, OVERRIDES_REL, setup } = require('./lib/prompt-overrides-env.ts')

let passed = 0
let failed = 0
const check = (ok: unknown, msg: string, detail?: unknown): void => {
  if (ok) { console.log('  PASS ' + msg); passed += 1 } else { console.log('  FAIL ' + msg + (detail ? ' —— ' + String(detail).slice(0, 400) : '')); failed += 1 }
}

async function main(): Promise<void> {
  console.log('提示词改写门禁之二（#100：校验、坏值、旧模板、写失败与接线）')
  const { store, makeEnv, readDoc, waitFor, ready, PARAMS } = await setup()

  // ── 第五件事：校验 ──
  console.log('')
  console.log('== 第五件事：未知占位符、丢了 {url}、空白文字各按约定处理，被拒的不写进文件 ==')
  {
    const env = makeEnv({ tag: 'validate' })
    env.mod.settingsViewLoad()
    await ready(env)
    const unknown = env.mod.setPromptOverride('mapInspect', 'hi {url} {nope}')
    check(unknown.ok === false && unknown.reason === 'invalid' && unknown.unknown.join() === 'nope', '未知占位符被拒，并说出是哪一个。', JSON.stringify(unknown))
    const missing = env.mod.setPromptOverride('tpl.fix', 'no link here')
    check(missing.ok === false && missing.reason === 'invalid' && missing.missing.join() === 'url', '默认正文里本来有 {url} 的提示词，丢了它被拒。', JSON.stringify(missing))
    const noUrlNeeded = env.mod.setPromptOverride('fixate', 'just fixate')
    check(noUrlNeeded.ok === true, '默认正文里本来就没有 {url} 的提示词不要求它。', JSON.stringify(noUrlNeeded))
    const blank = env.mod.setPromptOverride('mapInspect', '   \n  ')
    check(blank.ok === true && env.mod.promptOverrideStoredOf('mapInspect') === '', '去掉空白后为空，按「用默认文本」处理（存空串）。', JSON.stringify(blank))
    const unlisted = env.mod.setPromptOverride('setupRun', 'x')
    check(unlisted.ok === false && unlisted.reason === 'unknown-id', '名单之外的 id（setupRun）不接。')
    const vocab = env.mod.setPromptOverride('fixate', 'use {cli} here')
    check(vocab.ok === true, '词表占位符 {cli} 任何提示词都允许。', JSON.stringify(vocab))
    const help = env.mod.promptOverrideHelpOf('mapInspect')
    check(help.names.indexOf('url') >= 0 && help.required.join() === 'url' && help.names.indexOf('cli') < 0, '给设置页的说明行：能写的占位符里有 url、必须保留 url，词表占位符不占一行说明。', JSON.stringify(help))
    await sleep(env.mod.VIEW_FLAG_WRITE_DEBOUNCE_MS + 300)
    const doc = await readDoc(env.home)
    check(!!doc && !('nope' in JSON.parse(JSON.stringify(doc.promptOverrides))) && doc.promptOverrides['tpl.fix'] === undefined && doc.promptOverrides.setupRun === undefined, '被拒的几笔一个字都没进文件。', JSON.stringify(doc && doc.promptOverrides))
  }

  // ── 第六件事：手改文件造出的坏值不生效 ──
  console.log('')
  console.log('== 第六件事：手改文件造出的坏值不生效，按钮仍用默认文本 ==')
  {
    const env = makeEnv({ tag: 'badfile' })
    const w = await store.writeLocalSettings({ version: 1, ui: { stateFilter: '', sortKey: '', sortDir: '', labelClicks: {} }, workspaces: {}, debug: { enabled: false, sampleRate: 1 }, templates: {}, promptOverrides: { mapInspect: 'no link at all', 'tpl.fix': 'x {url} {zzz}', setupRun: 'HACK {trackerLine}', 'tpl.diagnose': 'OK {url}' } }, env.home, realIo)
    check(w.ok === true, '预置一份手写的文件（核只守形状，认不认得 id 由读它的这一边定）。', JSON.stringify(w))
    env.mod.settingsViewLoad()
    check(await ready(env), '读口就绪。')
    check(env.mod.promptText('mapInspect', PARAMS) === env.base.promptText('mapInspect', PARAMS), '丢了 {url} 的坏值不生效，按钮用默认文本。')
    check(env.mod.promptText('tpl.fix', PARAMS) === env.base.promptText('tpl.fix', PARAMS), '带未知占位符的坏值不生效。')
    check(env.mod.promptText('setupRun', {}) === env.base.promptText('setupRun', {}), '名单之外的 id 即使文件里写了也不生效。')
    check(env.mod.promptText('tpl.diagnose', PARAMS) === 'OK https://example.invalid/7', '同一份文件里合格的那一格照常生效（坏的不连累好的）。')
    check(env.mod.promptOverrideStoredOf('mapInspect') === 'no link at all' && env.mod.promptOverrideCheck('mapInspect', 'no link at all').ok === false, '设置页读得到这条坏值的原文，也判得出它不生效（好给用户说明原因）。')
  }

  // ── 第七件事：旧模板的老文本不挡新改写 ──
  console.log('')
  console.log('== 第七件事：旧 templates 节留着老文本时，同一个按钮的改写赢；没有改写时旧行为一字不变 ==')
  {
    const env = makeEnv({ tag: 'legacy', localStorage: { 'dsws.templates': JSON.stringify({ fix: 'OLD_FIX {url}', fixate: 'OLD_FIXATE' }) } })
    env.mod.settingsViewLoad()
    await ready(env)
    check(env.mod.tplText('fix', {}) === 'OLD_FIX {url}', '没有改写时旧模板老文本照旧生效（旧行为不变）。', env.mod.tplText('fix', {}))
    env.mod.setPromptOverride('tpl.fix', 'NEW FIX {url}')
    check(env.mod.tplText('fix', {}) === 'NEW FIX {url}', '存了改写之后，改写赢过老文本。', env.mod.tplText('fix', {}))
    check(env.mod.tplText('fixate', {}) === 'OLD_FIXATE', '别的按钮的老文本不受影响。')
    env.mod.setPromptOverride('fixate', 'NEW FIXATE')
    check(env.mod.tplText('fixate', {}) === 'NEW FIXATE', 'fixate 这个按钮的对应 id 是 fixate 本身，同样改写赢。', env.mod.tplText('fixate', {}))
    env.mod.setPromptOverride('tpl.fix', '')
    check(env.mod.tplText('fix', {}) === 'OLD_FIX {url}', '恢复默认之后老文本又回来（旧行为不变）。')
    // 对应关系：旧模板名 → 登记表 id 要与 config.ts 里 TPL_DEFAULT 取的 id 一致（tpl. 加名字，fixate 例外）。
    const ok = ['diagnose', 'fix', 'discuss', 'research', 'prototype', 'takeover', 'supplement', 'execute'].every((n) => env.mod.PROMPT_OVERRIDE_IDS.indexOf('tpl.' + n) >= 0)
    check(ok, '旧模板名与登记表 id 的对应（tpl. 加名字）在名单里逐个成立。')
  }

  // ── 第八件事：写不进文件时的底线 ──
  console.log('')
  console.log('== 第八件事：文件是更高版本就拒绝且不改字节；写失败时本次会话内改写仍生效 ==')
  {
    const env = makeEnv({ tag: 'readonly' })
    fs.mkdirSync(path.dirname(settingsPathIn(env.home)), { recursive: true })
    fs.writeFileSync(settingsPathIn(env.home), 'version: 9\n', 'utf8')
    env.mod.settingsViewLoad()
    check(await ready(env), '读口就绪（文件是高版本，结论是只读）。')
    const res = env.mod.setPromptOverride('mapInspect', 'X {url}')
    check(res.ok === false && res.reason === 'readonly', '高版本文件拒绝保存并说出原因。', JSON.stringify(res))
    check(fs.readFileSync(settingsPathIn(env.home), 'utf8').indexOf('version: 9') === 0, '高版本文件一个字节都没被改。')
    check(env.mod.promptText('mapInspect', PARAMS) === env.base.promptText('mapInspect', PARAMS), '拒绝之后按钮仍用默认文本。')
  }
  {
    const env = makeEnv({ tag: 'writefail', fsOverrides: { writeFile: async () => { const e: any = new Error('operation not permitted'); e.code = 'EPERM'; throw e } } })
    env.mod.settingsViewLoad()
    await ready(env)
    const res = env.mod.setPromptOverride('mapInspect', 'KEPT {url}')
    check(res.ok === true, '保存先按能写接下。')
    await sleep(env.mod.VIEW_FLAG_WRITE_DEBOUNCE_MS + 400)
    check(env.logs.some((l: any) => l.event === 'host.call.fail' && l.fields && l.fields.method === 'wf.setSettings'), '写失败在日志里留下既有的 host.call.fail 一行。')
    check(env.mod.promptText('mapInspect', PARAMS) === 'KEPT https://example.invalid/7', '写失败后本次会话内改写仍生效（内存文档里已经改好）。')
    check(fs.existsSync(settingsPathIn(env.home)) === false, '写失败时设置文件没有被建出来，也没有写到别处（本节没有旧键可退）。')
    check(env.ls.getItem('dsws.templates') === null, '没有把这一笔写进任何旧 localStorage 键。')
  }
  {
    const env = makeEnv({ tag: 'loading' })
    const res = env.mod.setPromptOverride('mapInspect', 'EARLY {url}')
    check(res.ok === true, '文档一次都没问过时保存先接下（先记着，等文档）。', JSON.stringify(res))
    const landed = await waitFor(async () => { const d = await readDoc(env.home); return !!d && d.promptOverrides.mapInspect === 'EARLY {url}' })
    check(landed, '文档到手之后这一笔落进了文件。', JSON.stringify(await readDoc(env.home)))
    check(env.mod.promptText('mapInspect', PARAMS) === 'EARLY https://example.invalid/7', '落地之后取用口给的是改写后的文本。')
  }

  // ── 第九件事：接线与行数 ──
  console.log('')
  console.log('== 第九件事：接线与行数 ==')
  {
    const build = readText('scripts/build.mts')
    check(build.indexOf("{ name: 'settingsPromptOverrides', file: 'src/client/kernel/settings-prompt-overrides.ts' }") >= 0, 'scripts/build.mts 登记了本片（不登记就静默不编译）。')
    check(build.indexOf("{ id: 'promptOverridesSection', file: 'src/client/views/PromptOverridesSection.ts' }") >= 0, 'scripts/build.mts 登记了设置页那一组。')
    check(readText('src/client/index.ts').indexOf('kernel:settingsPromptOverrides (spliced by build)') >= 0, '客户端入口有本片的拼接标记。')
    check(readText('src/client/views/SettingsPage.ts').indexOf('h(PromptOverridesSection,') >= 0, '设置页挂了「提示词改写」这一组。')
    check(readText('src/client/kernel/prompts.ts').indexOf('promptOverrideOf(id)') >= 0, '提示词取用口在取到默认正文之后问了改写口。')
    check(noExport(readText('src/client/kernel/settings-view-write.ts')).indexOf("d.section === 'promptOverrides') continue") >= 0, '写失败的兜底分支对本节只跳过、不写别处。')
    for (const rel of [OVERRIDES_REL, 'src/client/views/PromptOverridesSection.ts', 'src/client/kernel/settings-view-write.ts', 'src/client/kernel/settings-view.ts', 'src/client/kernel/settings-view-reload.ts', 'src/client/kernel/prompts.ts', 'src/client/kernel/config.ts', 'src/shared/config-store/src/settings.ts']) {
      const n = countEffectiveLines(readText(sourcePath(rel)))
      check(n <= 350, rel + ' 不超过三百五十有效行，实得 ' + n + ' 行。')
    }
  }


  console.log('')
  console.log(failed ? ('存在失败 — verify-100-prompt-overrides-rules 未通过（' + passed + ' 项通过、' + failed + ' 项失败）') : ('全部通过 — verify-100-prompt-overrides-rules 生效（' + passed + ' 项断言）'))
  printGateResult('verify-100-prompt-overrides-rules', passed + failed, failed)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.log('  FAIL 门禁自己抛错：' + String((e && e.stack) || e)); process.exit(1) })

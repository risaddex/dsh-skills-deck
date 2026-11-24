#!/usr/bin/env node
/**
 * verify-100-prompt-overrides.ts —— 提示词改写门禁之一（#100：设置页每个动作按钮一个输入框，默认用自带文本，可恢复默认）。
 *
 * 这份门禁量前几件事，每一件都用完整的一句话说清：
 * 第零件事是构建通过，且新片与设置页那一组真的进了双产物。
 * 第一件事是核认识新节：本机设置文件多了 promptOverrides 节，读写往返一致、缺节按空读、危险名字与非文字值被拒。
 * 第二件事是没有改写时一字不差：十七个有输入框的提示词，取用口给出的文本与「没有这一片」的基线逐字节相同。
 * 第三件事是存了改写，按钮就注入改写后的文本：{url} 照常替换，改写落进文件，另一个会话读同一份文件也看得到。
 * 第四件事是「恢复默认」：存空串、取用口回到默认正文、设置页那一格显示的就是默认正文。
 * 校验、坏值、旧模板、写失败与接线与行数在 tests/verify-100-prompt-overrides-rules.ts；夹具在 tests/lib/prompt-overrides-env.ts。
 *
 * 用法：node --import ./scripts/ts-hook.mts tests/verify-100-prompt-overrides.ts（在插件根目录；本脚本自己会先构建）
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
  console.log('提示词改写门禁之一（#100：核认识新节、没有改写时逐字节不变、保存与恢复默认）')
  const { buildStatus, core, store, makeEnv, readDoc, waitFor, ready, PARAMS } = await setup()

  // ── 第零件事：先构建，并确认新片与新叶子真的进了双产物 ──
  console.log('')
  console.log('== 第零件事：先跑构建（这一片的运行时形状来自拼接，不构建就证明不了它进了产物） ==')
  {
    check(buildStatus === 0, 'node scripts/build.mts 构建通过。', '退出码 ' + String(buildStatus))
    for (const rel of ['client.js', 'package/lib/client.js']) {
      const t = fs.existsSync(path.join(ROOT, rel)) ? readText(rel) : ''
      check(t.indexOf('const settingsPromptOverridesSetInDoc = function') >= 0 && t.indexOf('const setPromptOverride = function') >= 0,
        rel + ' 里拼进了提示词改写这一片（改写口与读口都在，才算真接上）。')
      check(t.indexOf('const setPromptOverride = function') > t.indexOf('const viewFlagWriteNow = function'),
        rel + ' 里这一片排在写这一趟之后（它要用那一片的待写队列与排期）。')
      check(t.indexOf('PromptOverridesSection = ') >= 0 || t.indexOf('const PromptOverridesSection') >= 0, rel + ' 里有设置页「提示词改写」这一组的画法。')
      check(t.indexOf('settingsPromptOverrides (spliced') < 0, rel + ' 里没有留下这一片的拼接标记（拼进去了）。')
    }
  }

  // ── 第一件事：核认识 promptOverrides 节 ──
  console.log('')
  console.log('== 第一件事：本机设置文件的核认识 promptOverrides 节 ==')
  {
    const empty = core.settingsEmptyDocument()
    check(JSON.stringify(empty.promptOverrides) === '{}', '空文档带一个空的 promptOverrides 节。')
    const parsed = core.parseSettings({ version: 1, promptOverrides: { mapInspect: 'x {url}', 'tpl.fix': '' } })
    check(parsed.ok === true && parsed.value.promptOverrides['tpl.fix'] === '' && parsed.value.promptOverrides.mapInspect === 'x {url}', '写了两格（含一个空串）读回来原样，空串合法。', JSON.stringify(parsed))
    const noSection = core.parseSettings({ version: 1 })
    check(noSection.ok === true && JSON.stringify(noSection.value.promptOverrides) === '{}', '缺节按空映射读（旧文件照样读得进来）。')
    const hostile = JSON.parse('{"version":1,"promptOverrides":{"__proto__":"x"}}')
    check(core.parseSettings(hostile).ok === false, '危险名字（__proto__）整份拒绝。')
    check(core.parseSettings({ version: 1, promptOverrides: { mapInspect: 3 } }).ok === false, '值不是文字整份拒绝。')
    check(core.parseSettings({ version: 1, promptOverrides: [] }).ok === false, '这一节不是映射整份拒绝。')
    const text = core.stringifySettings({ version: 1, promptOverrides: { mapInspect: 'line1\nline2 {url}', 'tpl.fix': '' } })
    check(text.ok === true && text.text.indexOf('promptOverrides:') >= 0 && text.text.indexOf('# Prompt overrides') >= 0, '写出的 YAML 里有这一节与它的注释。', JSON.stringify(text).slice(0, 300))
    const again = core.parseSettings(require('yaml').parse(text.text))
    check(again.ok === true && again.value.promptOverrides.mapInspect === 'line1\nline2 {url}' && again.value.promptOverrides['tpl.fix'] === '', '多行文字与空串经过 YAML 往返一字不差。', JSON.stringify(again))
    const merged = core.mergeSettingsPatch(empty, { promptOverrides: { mapInspect: 'A {url}' } })
    check(merged.ok === true && merged.value.promptOverrides.mapInspect === 'A {url}', '补丁只带一格也能并进去。')
    const cleared = core.mergeSettingsPatch(merged.value, { promptOverrides: { mapInspect: '' } })
    check(cleared.ok === true && cleared.value.promptOverrides.mapInspect === '' && cleared.changed === true, '补丁写空串能把一格恢复成默认（空串仍算一次改动）。')
  }

  // ── 第二件事：没有改写时一字不差 ──
  console.log('')
  console.log('== 第二件事：没有改写时，十七个提示词与「没有这一片」的基线逐字节相同 ==')
  {
    const env = makeEnv({ tag: 'identical' })
    const ids = env.mod.PROMPT_OVERRIDE_IDS
    check(ids.length === 17, '名单里是十七个提示词（维护者选的「ticket 与 map 上的动作按钮」）。', String(ids.length))
    check(ids.every((id: string) => !!env.mod.PROMPTS[id]), '名单里每个 id 在提示词登记表里都有（拼错或登记表删了都会红，这里与类型检查两道守）。')
    let same = true
    let which = ''
    for (const id of ids) {
      if (env.mod.promptTextFor(null, id, PARAMS) !== env.base.promptTextFor(null, id, PARAMS)) { same = false; which = id; break }
      if (env.mod.promptText(id, PARAMS) !== env.base.promptText(id, PARAMS)) { same = false; which = id; break }
    }
    check(same, '文档还在路上（没有任何改写）时，promptTextFor / promptText 与基线逐字节相同。', which)
    check(await ready(env), '文档到手。')
    same = true
    for (const id of ids) { if (env.mod.promptTextFor(null, id, PARAMS) !== env.base.promptTextFor(null, id, PARAMS)) { same = false; which = id; break } }
    check(same, '文档到手、promptOverrides 节是空的时同样逐字节相同。', which)
    check(fs.existsSync(settingsPathIn(env.home)) === false && env.calls.filter((c: any) => c.method === 'wf.setSettings').length === 0, '只是读、没有任何写入：设置文件不会被建出来。')
  }

  // ── 第三件事：存了改写，按钮就注入改写后的文本 ──
  console.log('')
  console.log('== 第三件事：存了改写 → 取用口给改写后的文本，{url} 照常替换，落进文件，另一个会话也看得到 ==')
  {
    const env = makeEnv({ tag: 'save' })
    env.mod.settingsViewLoad()
    check(await ready(env), '读口就绪。')
    const res = env.mod.setPromptOverride('mapInspect', 'MY INSPECT #{n} {title} → {url}')
    check(res.ok === true, '保存被接下。', JSON.stringify(res))
    check(env.mod.promptTextFor(null, 'mapInspect', PARAMS) === 'MY INSPECT #7 T → https://example.invalid/7', '取用口给的是改写后的文本，占位符已替换。', env.mod.promptTextFor(null, 'mapInspect', PARAMS))
    check(env.mod.promptTextFor(null, 'mapExecute', PARAMS) === env.base.promptTextFor(null, 'mapExecute', PARAMS), '别的提示词不受影响。')
    const landed = await waitFor(async () => { const d = await readDoc(env.home); return !!d && d.promptOverrides.mapInspect === 'MY INSPECT #{n} {title} → {url}' })
    check(landed, '改写落进了设置文件的 promptOverrides 节。', JSON.stringify(await readDoc(env.home)))
    const env2 = makeEnv({ tag: 'save-reader', home: env.home })
    env2.mod.settingsViewLoad()
    check(await ready(env2), '另一个会话读到了那份文件。')
    check(env2.mod.promptTextFor(null, 'mapInspect', PARAMS) === 'MY INSPECT #7 T → https://example.invalid/7', '另一个会话里按钮同样注入改写后的文本。')
    check(env2.mod.promptOverrideStoredOf('mapInspect') === 'MY INSPECT #{n} {title} → {url}', '设置页那一格读到的原文带着占位符原样。')
  }

  // ── 第四件事：恢复默认 ──
  console.log('')
  console.log('== 第四件事：恢复默认 → 存空串，取用口回到默认正文，设置页显示的就是默认正文 ==')
  {
    const env = makeEnv({ tag: 'restore' })
    env.mod.settingsViewLoad()
    await ready(env)
    env.mod.setPromptOverride('tpl.fix', 'MY FIX {url}')
    check(env.mod.promptText('tpl.fix', { url: 'U' }) === 'MY FIX U', '先存了一条改写。')
    const res = env.mod.setPromptOverride('tpl.fix', '')
    check(res.ok === true, '恢复默认被接下。', JSON.stringify(res))
    check(env.mod.promptText('tpl.fix', { url: 'U' }) === env.base.promptText('tpl.fix', { url: 'U' }), '取用口回到默认文本，与基线逐字节相同。')
    const shown = env.mod.promptOverrideStoredOf('tpl.fix').trim() !== '' ? env.mod.promptOverrideStoredOf('tpl.fix') : env.mod.promptOverrideDefaultOf('tpl.fix')
    check(shown === env.mod.PROMPTS['tpl.fix'].zh, '设置页那一格显示的是插件自带的默认正文（未替换占位符）。')
    const landed = await waitFor(async () => { const d = await readDoc(env.home); return !!d && d.promptOverrides['tpl.fix'] === '' })
    check(landed, '文件里这一格写成了空串（空串 = 用默认文本）。', JSON.stringify(await readDoc(env.home)))
    env.mod.setPromptOverride('tpl.fix', 'MY FIX {url}')
    const same = env.mod.setPromptOverride('tpl.fix', env.mod.promptOverrideDefaultOf('tpl.fix'))
    check(same.ok === true && env.mod.promptOverrideStoredOf('tpl.fix') === '', '把文字改回与默认正文逐字相同，按「没有改写」存空串（以后默认文本升级了会跟着用新的）。')
  }

  console.log('')
  console.log(failed ? ('存在失败 — verify-100-prompt-overrides 未通过（' + passed + ' 项通过、' + failed + ' 项失败）') : ('全部通过 — verify-100-prompt-overrides 生效（' + passed + ' 项断言）'))
  printGateResult('verify-100-prompt-overrides', passed + failed, failed)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.log('  FAIL 门禁自己抛错：' + String((e && e.stack) || e)); process.exit(1) })

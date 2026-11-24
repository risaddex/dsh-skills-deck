#!/usr/bin/env node
/**
 * verify-113-prompt-fields-collapse.ts —— 设置页「提示词改写」每一格默认收起、点名字展开的门禁（#113）。
 *
 * 这份门禁量四件事，每一件都用完整的一句话说清：
 * 第一件事是刚打开时十七格全部收起：每一行只有按钮名字与右边向下的箭头，页面上一个输入框也没有。
 * 第二件事是点一行名字就展开：展开后出现原来有的东西（占位符说明、输入框、保存与恢复默认两颗按钮），箭头转向上。
 * 第三件事是收起不丢草稿：在输入框里改了字、没保存就收起，收起的那一行亮出「未保存」标记，再展开时草稿还在。
 * 第四件事是已改写的一格收起时仍亮出「已改写」标记：不用展开就看得出哪几格动过。
 * 怎么保证量的是真件：设置页这一组的真源（src/client/views/PromptOverridesSection.ts）按构建同一种做法转译后当场求值，
 * 用真的 React 与 jsdom 渲染、派发真的点击与输入事件；只有内核那几个口子（改写的读写与名单）与词表是替身，
 * 它们的真实现由 tests/verify-100-prompt-overrides*.ts 守。
 *
 * 用法：node --import ./scripts/ts-hook.mts tests/verify-113-prompt-fields-collapse.ts（在插件根目录）
 */
const { JSDOM } = require('jsdom')
const { compileFn } = require('./lib/eval-probe.ts')
const { spliceableJs } = require('./lib/source-text.ts')
const { printGateResult } = require('./lib/gate-result.ts')

let passed = 0
let failed = 0
const check = (ok: unknown, msg: string, detail?: unknown): void => {
  if (ok) { console.log('  PASS ' + msg); passed += 1 } else { console.log('  FAIL ' + msg + (detail ? ' —— ' + String(detail).slice(0, 400) : '')); failed += 1 }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  console.log('提示词改写每一格默认收起、点名字展开门禁（#113）')
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true })
  const g = globalThis as any
  g.window = dom.window
  g.document = dom.window.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  const React = require('react')
  const { createRoot } = require('react-dom/client')
  const { act } = React

  const IDS = ['mapInspect', 'tpl.fix', 'fixate']
  const stored: Record<string, string> = { 'tpl.fix': 'MY FIX {url}' }
  const help = (id: string) => ({ names: id === 'fixate' ? [] : ['url'], required: id === 'fixate' ? [] : ['url'] })
  const names = ['React', 'DswsCtx', 'tr', 'Ic', 'flash', 'useStore', 'PROMPT_OVERRIDE_IDS', 'promptOverrideOf', 'promptOverrideStoredOf', 'promptOverrideDefaultOf', 'promptOverrideHelpOf', 'promptOverrideCheck', 'setPromptOverride']
  const body = spliceableJs('src/client/views/PromptOverridesSection.ts')
  const factory = compileFn(names, body + '\nreturn PromptOverridesSection')
  const Section = factory(
    React,
    React.createContext(null),
    (key: string) => key,
    (p: any) => React.createElement('svg', { 'data-icon': p.n }),
    () => {},
    () => ({}),
    IDS,
    (id: string) => (stored[id] ? stored[id] : ''),
    (id: string) => stored[id] || '',
    (id: string) => 'DEFAULT ' + id,
    help,
    () => ({ ok: true, empty: false, unknown: [], missing: [] }),
    () => ({ ok: true }),
  )

  const host = document.getElementById('root') as HTMLElement
  const root = createRoot(host)
  await act(async () => { root.render(React.createElement(Section, {})) })

  const rows = () => Array.from(host.querySelectorAll('button[data-log^="settings.prompt.toggle."]')) as HTMLElement[]
  const rowOf = (id: string) => host.querySelector('button[data-log="settings.prompt.toggle.' + id.toLowerCase() + '"]') as HTMLElement
  const textareas = () => host.querySelectorAll('textarea')
  const caretOf = (el: HTMLElement) => (el.querySelector('svg') as Element).getAttribute('data-icon')

  console.log('')
  console.log('== 第一件事：刚打开时全部收起，只有名字与向下的箭头 ==')
  check(rows().length === IDS.length, '每一格都有一行可点的名字（' + IDS.length + ' 行）。', String(rows().length))
  check(textareas().length === 0, '页面上一个输入框也没有。')
  check(host.querySelectorAll('button[data-log^="settings.prompt.save."]').length === 0, '保存与恢复默认两颗按钮也都不画。')
  check(rows().every((r) => caretOf(r) === 'chev-down' && r.getAttribute('aria-expanded') === 'false'), '每一行右边都是向下的箭头，且声明自己是收起的。')
  check(rowOf('mapInspect').textContent === 'po.name.mapInspect', '没有改写的一行里只有按钮名字（没有别的字）。', rowOf('mapInspect').textContent)

  console.log('')
  console.log('== 第四件事：已改写的一格收起时仍亮出标记 ==')
  check((rowOf('tpl.fix').textContent || '').indexOf('po.custom') >= 0, '已改写的那一格收起时带着「已改写」标记。', rowOf('tpl.fix').textContent)
  check((rowOf('mapInspect').textContent || '').indexOf('po.custom') < 0, '没改写的格没有这个标记。')

  console.log('')
  console.log('== 第二件事：点名字展开，箭头转向 ==')
  await act(async () => { rowOf('mapInspect').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  check(textareas().length === 1, '展开后出现这一格的输入框（其余仍收起，只有一个）。', String(textareas().length))
  check(caretOf(rowOf('mapInspect')) === 'chev-up' && rowOf('mapInspect').getAttribute('aria-expanded') === 'true', '展开那一行的箭头转向上。')
  check(host.querySelector('button[data-log="settings.prompt.save.mapinspect"]') !== null && host.querySelector('button[data-log="settings.prompt.restore.mapinspect"]') !== null, '展开后保存与恢复默认两颗按钮都在。')
  check((textareas()[0] as HTMLTextAreaElement).value === 'DEFAULT mapInspect', '输入框里是这一格现在生效的文本（没改写就是默认正文）。')

  console.log('')
  console.log('== 第三件事：收起不丢草稿 ==')
  const ta = textareas()[0] as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, 'MY DRAFT {url}')
    ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  check((textareas()[0] as HTMLTextAreaElement).value === 'MY DRAFT {url}', '在输入框里改字之后草稿在输入框里。')
  await act(async () => { rowOf('mapInspect').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  check(textareas().length === 0 && caretOf(rowOf('mapInspect')) === 'chev-down', '再点一下收起：输入框不画了，箭头回到向下。')
  check((rowOf('mapInspect').textContent || '').indexOf('po.unsaved') >= 0, '收起的那一行亮出「未保存」标记，草稿不会藏在收起的格子里。', rowOf('mapInspect').textContent)
  await act(async () => { rowOf('mapInspect').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  check((textareas()[0] as HTMLTextAreaElement).value === 'MY DRAFT {url}', '再展开时草稿还在。')

  await act(async () => { root.unmount() })
  await sleep(0)

  console.log('')
  console.log(failed ? ('存在失败 — verify-113-prompt-fields-collapse 未通过（' + passed + ' 项通过、' + failed + ' 项失败）') : ('全部通过 — 提示词改写收起展开门禁生效（' + passed + ' 项断言）'))
  printGateResult('verify-113-prompt-fields-collapse', passed + failed, failed)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.log('  FAIL 门禁自己抛错：' + String((e && e.stack) || e)); process.exit(1) })

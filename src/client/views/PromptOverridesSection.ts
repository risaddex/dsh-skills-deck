/**
 * PromptOverridesSection.ts —— 设置页「提示词改写」分组（#100）：每个动作按钮一个输入框，可保存、可恢复默认。
 *
 * 这一份只管画与接线：判据（哪些 id 有输入框、占位符合不合格、存成什么）都在
 * kernel/settings-prompt-overrides.ts，这里只调它的口子，不另抄一份规则。
 *
 * 一格的状态只有两件事：用户正在输入框里改的草稿（drafts，没保存前不影响按钮），和上一次保存失败的原因（errors）。
 * 输入框显示的是「这一刻按钮实际会用的文本」：有生效的改写就是改写，否则是插件自带的默认正文
 * （占位符仍写成 {url} 这样，因为改写存的就是带占位符的原文）。「恢复默认」存一个空串，输入框随之回到默认正文。
 *
 * 跨叶子的值引用按仓里规矩写模块级 declare（实现只在闭包里有一份，类型检查各看各的）：
 * 全局已声明的（React、DswsCtx、tr）直接用；下面这几行是本文件自己声明的，只写本页实际用的形状。
 */
declare function useStore(sessionId?: unknown): unknown
declare function flash(store: unknown, message: string, kind: 'ok' | 'warn'): void
declare const Ic: (props: { n: string; size: number }) => unknown
declare const PROMPT_OVERRIDE_IDS: ReadonlyArray<string>
declare function promptOverrideOf(id: string): string
declare function promptOverrideStoredOf(id: string): string
declare function promptOverrideDefaultOf(id: string): string
declare function promptOverrideHelpOf(id: string): { names: string[]; required: string[] }
declare function promptOverrideCheck(id: string, text: string): { ok: boolean; empty: boolean; unknown: string[]; missing: string[] }
declare function setPromptOverride(id: string, text: string): { ok: boolean; reason?: string; unknown?: string[]; missing?: string[] }

type PromptFieldFailure = { reason?: string; unknown?: string[]; missing?: string[] }

/** 把占位符名列表写成 {url} {title} 这样的一行字（给人看的，所以带花括号）。 */
const braceList = function (names: string[]): string {
  return names.map(function (n) { return '{' + n + '}' }).join(' ')
}

/**
 * 把一次失败（保存被拒，或存着的文字校验不过）翻成一句人话。
 * 占位符问题优先说（用户能直接改）；其余按 reason 说；认不出的原因落通用一句，不把内部枚举露给用户。
 */
const failText = function (f: PromptFieldFailure): string {
  const parts: string[] = []
  if (f.unknown && f.unknown.length > 0) parts.push(tr('po.errUnknown', { names: braceList(f.unknown) }))
  if (f.missing && f.missing.length > 0) parts.push(tr('po.errMissing', { names: braceList(f.missing) }))
  if (parts.length > 0) return parts.join(' ')
  if (f.reason === 'loading') return tr('po.errLoading')
  if (f.reason === 'readonly') return tr('po.errReadonly')
  if (f.reason === 'unavailable') return tr('po.errUnavailable')
  return tr('po.errGeneric')
}

/** 日志与按压的定位串里不许有大写（verify-ui-feedback 的 H3），所以 id 先转小写；转后仍互不相同。 */
const logKeyOf = function (id: string): string { return id.toLowerCase() }

export const PromptOverridesSection = (props: { sessionId?: unknown }): unknown => {
  const cx = React.useContext(DswsCtx)
  const h = cx ? cx.h : React.createElement
  // 订阅 store：设置页的提示与重画都靠它（与 DiagnosticLogSection 同一套），保存后的 flash 也用它弹。
  const sharedSt = cx ? cx.storeSvc.useStore(props && props.sessionId) : useStore(props && props.sessionId)
  const [drafts, setDrafts] = React.useState({} as Record<string, string>)
  const [errors, setErrors] = React.useState({} as Record<string, string>)

  const dropKey = function (m: Record<string, string>, id: string): Record<string, string> {
    const next = Object.assign({}, m)
    delete next[id]
    return next
  }
  const settle = function (id: string, ok: boolean, message: string, doneKey: string): void {
    if (ok) {
      setDrafts(function (m: Record<string, string>) { return dropKey(m, id) })
      setErrors(function (m: Record<string, string>) { return dropKey(m, id) })
      try { flash(sharedSt, tr(doneKey), 'ok') } catch (eF) { /* 提示弹不出来不影响已经保存的结果 */ }
      return
    }
    setErrors(function (m: Record<string, string>) { return Object.assign({}, m, { [id]: message }) })
  }
  const save = function (id: string): void {
    const draft = drafts[id]
    if (draft === undefined) return
    const res = setPromptOverride(id, draft)
    settle(id, !!(res && res.ok), failText(res || {}), 'po.saved')
  }
  const restore = function (id: string): void {
    const res = setPromptOverride(id, '')
    settle(id, !!(res && res.ok), failText(res || {}), 'po.restored')
  }

  const fieldOf = function (id: string): unknown {
    // 读口 promptOverrideOf 顺带触发惰性加载设置文档（第一次画这一组时文档可能还在路上，到手后 store 通知重画）。
    const inEffect = promptOverrideOf(id) !== ''
    const stored = promptOverrideStoredOf(id)
    const hasStored = stored.trim() !== ''
    const shown = hasStored ? stored : promptOverrideDefaultOf(id)
    const draft = drafts[id]
    const value = draft === undefined ? shown : draft
    const dirty = draft !== undefined && draft !== shown
    const help = promptOverrideHelpOf(id)
    const key = logKeyOf(id)
    // 存着的文字没生效（手改文件造出的坏值）：说明原因，按钮此刻仍在用默认文本。
    const inactive = hasStored && !inEffect ? failText(promptOverrideCheck(id, stored)) : ''
    const rows = Math.min(16, Math.max(4, value.split('\n').length + 1))
    return h('div', { key: id, className: 'dsws-cfg-card' }, [
      h('div', { key: 'head', className: 'dsws-cfg-card-head' }, [
        h('span', { className: 'dsws-cfg-card-name' }, tr('po.name.' + id)),
        inEffect ? h('span', { className: 'dsws-cfg-chip', style: { cursor: 'default' } }, tr('po.custom')) : null,
      ]),
      h('div', { key: 'ph', className: 'dsws-cfg-card-desc' }, [
        help.names.length > 0 ? tr('po.placeholders', { names: braceList(help.names) }) : '',
        help.required.length > 0 ? ' · ' + tr('po.required', { names: braceList(help.required) }) : '',
      ].join('')),
      h('textarea', {
        key: 'ta',
        className: 'dsws-cfg-ta',
        'data-log': 'settings.prompt.field.' + key,
        rows: rows,
        style: { overflow: 'auto', resize: 'vertical' },
        value: value,
        spellCheck: false,
        onChange: function (e: { target: { value: string } }) {
          const text = e.target.value
          setDrafts(function (m: Record<string, string>) { return Object.assign({}, m, { [id]: text }) })
          setErrors(function (m: Record<string, string>) { return dropKey(m, id) })
        },
      }),
      errors[id] ? h('div', { key: 'err', className: 'dsws-cfg-err', style: { marginTop: 6 } }, errors[id]) : null,
      !errors[id] && inactive ? h('div', { key: 'off', className: 'dsws-cfg-err', style: { marginTop: 6 } }, tr('po.inactive', { why: inactive })) : null,
      h('div', { key: 'btns', className: 'dsws-cfg-row', style: { gap: 6, marginTop: 6 } }, [
        h('button', { key: 'save', className: 'dsws-cfg-btn', 'data-press': 'button', 'data-log': 'settings.prompt.save.' + key, disabled: !dirty, onClick: function () { save(id) } }, tr('po.save')),
        h('button', { key: 'restore', className: 'dsws-cfg-btn', 'data-press': 'button', 'data-log': 'settings.prompt.restore.' + key, disabled: !hasStored && draft === undefined, onClick: function () { restore(id) } }, tr('po.restore')),
      ]),
    ])
  }

  return h('div', { className: 'dsws-cfg-group' }, [
    h('div', { key: 'title', className: 'dsws-cfg-gtitle' }, [Ic({ n: 'gear', size: 13 }), h('span', null, tr('po.title'))]),
    h('div', { key: 'desc', className: 'dsws-cfg-gdesc' }, tr('po.desc')),
  ].concat(PROMPT_OVERRIDE_IDS.map(fieldOf)))
}

/**
 * 手机读通道的可选字段校验。字段缺席仍可转发旧版回包，明确的空清单照常通过；只有字段存在但不合规时才拒绝。
 * 调用方先校验主体和信封，本模块不解析会话、不处理失败回包，也不改变通过校验的数据。
 */

type ReplyLimits = {
  maxTickets: number
  maxActions: number
  maxActionIdChars: number
  maxActionLabelChars: number
  maxActionPromptBytes: number
}

declare const TextEncoder: { new(): { encode(text: string): Uint8Array } }

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function rowOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function field(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && value.trim() !== ''
}

/** 独立票与容器子票共用额度；独立票必须有可导航的键，且处于开放状态。 */
export function validDeckStandaloneIssues(reply: Record<string, unknown>, containers: unknown[], limits: ReplyLimits): boolean {
  if (!hasOwn(reply, 'standaloneIssues')) return true
  const standalone = reply.standaloneIssues
  if (!Array.isArray(standalone)) return false
  let count = standalone.length
  for (const container of containers) {
    const children = rowOf(container)?.tickets
    if (Array.isArray(children)) count += children.length
    if (count > limits.maxTickets) return false
  }
  return count <= limits.maxTickets && standalone.every((value) => {
    const row = rowOf(value)
    return row?.state === 'OPEN' && typeof row.key === 'string' && row.key.trim() !== ''
  })
}

/** 同次详情里的动作名称不能撞车；提示词按实际 UTF-8 字节量，不能靠裁字通过。 */
export function validDeckTicketActions(ticket: Record<string, unknown>, limits: ReplyLimits): boolean {
  if (!hasOwn(ticket, 'actions')) return true
  const actions = ticket.actions
  if (!Array.isArray(actions) || actions.length > limits.maxActions) return false
  const ids = new Set<string>()
  const encoder = new TextEncoder()
  for (const value of actions) {
    const action = rowOf(value)
    if (!action || !field(action.id, limits.maxActionIdChars) || ids.has(action.id)
      || !field(action.label, limits.maxActionLabelChars) || !field(action.prompt, limits.maxActionPromptBytes)
      || encoder.encode(action.prompt).length > limits.maxActionPromptBytes) return false
    ids.add(action.id)
  }
  return true
}

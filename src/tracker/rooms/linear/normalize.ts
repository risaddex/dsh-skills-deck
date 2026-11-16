/**
 * src/tracker/rooms/linear/normalize.ts —— Linear 的节点 → 契约的 Issue
 *
 * 契约要求「完整形状」：核心字段永远在，缺的用 ''/null 补；能力字段能实现就给值（空数组是
 * EMPTY），不能实现就整个省略（MISSING）。本房今天能给的：标签、指派人、父票。
 * 给不了的（评论、里程碑、自定义字段、评审）先省略，等对应操作实现时再补。
 *
 * 三个翻译点值得记住，它们都在研究笔记里有出处：
 *   · 状态只有 open/closed 两态，Linear 的七个 type 里 completed / canceled / duplicate 算关；
 *   · 地图靠 wayfinder:map 标签认（与另外两房同一口径）；
 *   · 票的稳定身份是 uuid，显示用 identifier；契约的 key 用 identifier，因为它与另外两房同形。
 */
import type { Issue, Label } from '../../contract/entities.js'
import type { IssueType, State } from '../../contract/identity.js'

/** Linear 的节点形状（只声明本文件读到的格，多的一律不碰）。 */
export interface LinearIssueNode {
  id?: string
  identifier?: string
  title?: string
  description?: string | null
  url?: string
  createdAt?: string
  updatedAt?: string
  state?: { name?: string; type?: string } | null
  team?: { key?: string; name?: string } | null
  parent?: { identifier?: string } | null
  assignee?: { name?: string; displayName?: string } | null
  labels?: { nodes?: { name?: string; color?: string }[] } | null
}

/** 关票的三种 workflow state type（研究笔记 §7）；其余都是开着。 */
const CLOSED_STATE_TYPES = ['completed', 'canceled', 'duplicate']

export function stateOf(type: string | undefined): State {
  return CLOSED_STATE_TYPES.includes(String(type || '').toLowerCase()) ? 'closed' : 'open'
}

/** 地图与规格是容器，普通票是 issue。规格的正文标记要读正文文件头，等写侧切片一起做。 */
export function issueTypeOf(labels: Label[]): IssueType {
  return labels.some((label) => label.name === 'wayfinder:map') ? 'map' : 'issue'
}

/** 一批标签节点 → 契约的 Label；没有名字的节点丢掉（半条数据不如没有）。 */
export function labelsOf(node: LinearIssueNode): Label[] {
  const nodes = node.labels && Array.isArray(node.labels.nodes) ? node.labels.nodes : []
  const out: Label[] = []
  for (const item of nodes) {
    const name = String(item?.name || '')
    if (!name) continue
    // Label.color 在契约里是必填：Linear 每条标签都带色值，没带就补空串（明确「不知道什么色」）。
    out.push({ name, color: String(item?.color || '') })
  }
  return out
}

/** 一个节点 → 一张票。核心字段一个不少，缺的按契约补。 */
export function issueOf(node: LinearIssueNode): Issue {
  const labels = labelsOf(node)
  const issue: Issue = {
    key: String(node.identifier || node.id || ''),
    effortId: '',
    type: issueTypeOf(labels),
    title: String(node.title || ''),
    state: stateOf(node.state?.type),
    body: String(node.description ?? ''),
    url: String(node.url || ''),
    createdAt: String(node.createdAt || ''),
    updatedAt: String(node.updatedAt || ''),
    closedAt: null,
    parentKey: node.parent?.identifier ? String(node.parent.identifier) : null,
    labels,
  }
  if (node.assignee) {
    const login = String(node.assignee.name || '')
    if (login) {
      issue.assignees = [{ login, ...(node.assignee.displayName ? { name: String(node.assignee.displayName) } : {}) }]
    }
  }
  return issue
}

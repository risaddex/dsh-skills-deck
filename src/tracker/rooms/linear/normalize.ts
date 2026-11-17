/**
 * src/tracker/rooms/linear/normalize.ts —— Linear 的节点 → 契约的 Issue
 *
 * 契约要求「完整形状」：核心字段永远在，缺的用 ''/null 补；能力字段能实现就给值（空数组是
 * EMPTY），不能实现就整个省略（MISSING）。本房今天能给的：标签、指派人、父票。
 * 给不了的（评论、里程碑、自定义字段、评审）先省略，等对应操作实现时再补。
 *
 * 三个翻译点值得记住，它们都在研究笔记里有出处：
 *   · 状态只有 open/closed 两态，Linear 的七个 type 里 completed / canceled / duplicate 算关；
 *   · 地图靠 wayfinder:map 标签认、规格靠正文文件头的 DSH-ISSUE-KIND: spec 标记认（与另外三房同一口径）；
 *   · 票的稳定身份是 uuid，显示用 identifier；契约的 key 用 identifier，因为它与另外两房同形。
 */
import type { Issue, Label } from '../../contract/entities.js'
import type { IssueType, State } from '../../contract/identity.js'
import { normalizeColor } from '../../../shared/label-color/src/colors.js'
import { markerKindInHeader } from '../../../shared/issue-file/src/marker.js'

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

/**
 * 关票的三种 workflow state type（研究笔记 §7）；其余都是开着。
 *
 * 导出而不是各写一份：读侧的查询条件（`state.type in / nin`）与这里的判定必须是同一张表，
 * 分成两份的话，改了一边就会出现「查询按关票过滤、翻译却说是开着」这种对不上的名单。
 */
export const CLOSED_STATE_TYPES = ['completed', 'canceled', 'duplicate']

export function stateOf(type: string | undefined): State {
  return CLOSED_STATE_TYPES.includes(String(type || '').toLowerCase()) ? 'closed' : 'open'
}

/**
 * 地图与规格是容器，普通票是 issue。判定顺序与另外三间房一致：**正文文件头的标记最前**，其次才是标签。
 *
 * 为什么规格看正文、不看标签：规格没有自己的标签（也不许带 `wayfinder:map`，带了会被认成探索地图），
 * 它的唯一真源是正文文件头独占一行的 `<!-- DSH-ISSUE-KIND: spec -->`（见 `contract/vocabulary.ts` 的
 * `SPEC_BODY_MARKER`）。GitHub 房、GitLab 房、本地 Markdown 房读的是同一个共享函数 `markerKindInHeader`，
 * 这里不另写一套判据，否则同一张规格换一间房读就变成普通票。
 *
 * `body` 是可选的第二个参数：只有手里有正文的调用方（`issueOf`）才传；不传就只看标签，旧调用点行为不变。
 */
export function issueTypeOf(labels: Label[], body?: unknown): IssueType {
  if (markerKindInHeader(body) === 'spec') return 'spec'
  return labels.some((label) => label.name === 'wayfinder:map') ? 'map' : 'issue'
}

/** 一批标签节点 → 契约的 Label；没有名字的节点丢掉（半条数据不如没有）。 */
export function labelsOf(node: LinearIssueNode): Label[] {
  const nodes = node.labels && Array.isArray(node.labels.nodes) ? node.labels.nodes : []
  const out: Label[] = []
  for (const item of nodes) {
    const name = String(item?.name || '')
    if (!name) continue
    // 颜色必须过共享的归一化：契约要的是「不带井号的小写六位」，而 Linear 给的是 `#EB5757`。
    // 原样透传会让界面拼成 `##EB5757`（视图自己会补一个井号），颜色整条失效。
    // Label.color 在契约里是必填：归一化不出来的（空串、位数不对、非十六进制）补空串，
    // 表示「这个标签不知道什么色」，而不是猜一个近似值。
    out.push({ name, color: normalizeColor(item?.color) ?? '' })
  }
  return out
}

/** 一个节点 → 一张票。核心字段一个不少，缺的按契约补。 */
export function issueOf(node: LinearIssueNode): Issue {
  const labels = labelsOf(node)
  const issue: Issue = {
    key: String(node.identifier || node.id || ''),
    effortId: '',
    type: issueTypeOf(labels, node.description),
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
  // 契约的 assignees 有三态，这里必须分清（PR #26 review 的 P2）：
  //   · 字段根本没问（undefined）——「不知道谁被指派」，整个字段省略；
  //   · 问了、答案是 null ——「明确没有人」，写空数组。省略会让刷新路径以为没变化，
  //     于是在 Linear 里把人取消指派之后，库里还留着原来的负责人；
  //   · 问了、有人 —— 写那一个人。
  if (node.assignee === null) {
    issue.assignees = []
  } else if (node.assignee) {
    const login = String(node.assignee.name || '')
    if (login) {
      issue.assignees = [{ login, ...(node.assignee.displayName ? { name: String(node.assignee.displayName) } : {}) }]
    }
  }
  return issue
}

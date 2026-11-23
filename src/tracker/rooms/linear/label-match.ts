/**
 * src/tracker/rooms/linear/label-match.ts —— 标签名的归一与匹配：名字怎么去重、怎么找、同名挑哪一条
 *
 * 从 `labels.ts` 拆出来的原因：这几样只回答「名字」的问题，不碰网络，而 `labels.ts` 还要管查询、建标签与写票；
 * 放在一起时那一份已经超过文件体量的上限。拆开后这里一个请求都不发，可以单独测。
 *
 * 口径只有一条（#85）：标签名**不分大小写**。Linear 自己把 `Bug` 与 `bug` 当同一个名字，所以去重、查找、
 * 同名挑选都按这一条走；而**写出去**的名字仍然原样，契约说名字原样读回。
 */
import type { LabelInput } from '../../contract/inputs.js'
import type { OpResult } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { linearError } from './errors.js'

/** 一批名字的标签过滤：各名字一条忽略大小写的相等条件，用 `or` 连起来（名字的顺序即调用方的顺序）。 */
export function labelNameFilter(wanted: WantedLabel[]): { or: Array<{ name: { eqIgnoreCase: string } }> } {
  return { or: wanted.map((item) => ({ name: { eqIgnoreCase: item.name } })) }
}

/** 标签名的比较口径：不分大小写，与 Linear 判定「同名」的方式一致（#85）。 */
function sameLabelName(a: unknown, b: unknown): boolean {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase()
}

/** 调用方给的一条标签，归一成这里真正要用的三格。 */
export interface WantedLabel {
  /**
   * 标签名，**原样**用：契约说名字原样读回，所以建标签时也原样写，不折叠大小写、不去空白。
   * 「原样」只管写出去的那一份；**找**已有标签时不分大小写（#85，见 `labels.ts` 的 `LABELS_BY_NAME`），
   * 因此调用方写 `bug`、工作区里是 `Bug`，用的是 `Bug` 那一条，而不是再建一个。
   */
  name: string
  /** 建新标签时用的颜色，形如 `#EB5757`；空串表示调用方没给，建的时候整个省掉。 */
  color: string
  /** 建新标签时带的说明；空串表示不传。 */
  description: string
}

/**
 * 契约的颜色写法是「不带井号的六位十六进制」，Linear 收 `#EB5757` 这种（§4 的 `color` 字段说明）。
 *
 * 认不出来就回空串让调用方省掉这一格，由 Linear 用它自己的默认色：猜一个近似值等于写下一个
 * 谁都没要过的颜色，而颜色在这个后端没有回读校验的位置让人发现错了。
 */
function hexColorOf(color: unknown): string {
  const digits = String(color ?? '').trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(digits) ? '#' + digits : ''
}

/**
 * 把 `LabelInput[]` 归一成 `WantedLabel[]`，并按名字去重（先出现的那个说了算）。
 *
 * 为什么要去重：Linear 的 `labelIds` 是一组标签，同一个 id 写两次没有意义，还可能被判成非法输入；
 * 而调用方那张清单常常是「票上已有的 + 这次加的」拼起来的，重名是常态而不是错误。
 * 去重**不分大小写**（#85）：Linear 把 `Bug` 与 `bug` 当同一个名字，两者都留下就会解析成同一个 id、
 * 写出重复的 id，缺失时还会先建 `Bug`、再因撞名建不出 `bug`。
 * 为什么名字不合规要整条拒绝而不是跳过：少贴一个标签而照样回「成功」，调用方只会以为已经贴上了。
 */
export function wantedLabelsOf(labels: LabelInput[]): OpResult<WantedLabel[]> {
  const list = Array.isArray(labels) ? labels : []
  const seen = new Set<string>()
  const wanted: WantedLabel[] = []
  for (const item of list) {
    const source: any = item
    const name = typeof source === 'string' ? source : String((source && source.name) || '')
    // 全是空白的名字不是「一个叫空的标签」，而是调用方把一个空值当成了标签：拒绝，不猜它的本意。
    if (!name.trim()) {
      return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'a label needs a name: Linear names are 1 to 80 characters, and a blank one cannot be matched or created') }
    }
    const folded = name.toLowerCase()
    if (seen.has(folded)) continue
    seen.add(folded)
    wanted.push({
      name,
      color: typeof source === 'string' ? '' : hexColorOf(source && source.color),
      description: typeof source === 'string' ? '' : String((source && source.description) || ''),
    })
  }
  return { ok: true, data: wanted }
}

/**
 * 同名标签可能不止一条：工作区标签一处（§4：`IssueLabel.team` 为 null 就是工作区标签），
 * 各团队标签各一处。名字是调用方给的唯一线索，所以按固定顺序挑一条，不让结果随回包顺序变：
 *   ① 绑定声明里那个团队的标签 —— 调用方看的通常就是本团队那份清单；
 *   ② 工作区标签 —— 它对每个团队都可用，是被 Linear 拒掉的可能性最小的一种；
 *   ③ 其余任意一条 —— 别的团队的标签可能被 Linear 以「不可用于这张票的团队」拒掉，
 *      那时会如实失败，绝不假装已经贴上。
 *
 * 名字不分大小写（#85）：`Bug` 满足对 `bug` 的请求。同一档里若有多种写法，调用方原样写的那一种优先，
 * 其余按回包顺序 —— 这样一个把名字写对的调用方，拿到的就是和以前同一条标签。
 */
export function pickLabel(found: any[], name: string, teamKey: string): any | null {
  const same = found.filter((node: any) => node && sameLabelName(node.name, name))
  if (same.length === 0) return null
  const preferExact = (list: any[]): any | null => list.find((node: any) => String(node.name || '') === name) || list[0] || null
  const wantedTeam = String(teamKey || '').toUpperCase()
  if (wantedTeam) {
    const own = same.filter((node: any) => node.team && String(node.team.key || '').toUpperCase() === wantedTeam)
    if (own.length > 0) return preferExact(own)
  }
  // 只认「本团队的」或「工作区的」：别的团队的标签**不能**用在这张票上（Linear 要求标签对该票所在
  // 团队可用，见研究笔记 §4）。回 null 让上游把它当缺失、走建标签那条路 —— 拿另一个团队的 id 去写，
  // 换来的是对端拒绝，而调用方看到的是一次「本来合法」的失败（PR #32 review 的 P2）。
  return preferExact(same.filter((node: any) => !node.team))
}

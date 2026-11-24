/**
 * src/tracker/rooms/linear/label-create.ts —— 缺的标签名怎么建出来，以及建不成时那张能照着做的失败（#92 拆分）
 *
 * 从 `labels.ts` 拆出来的原因只有一条：那一份加上 #92 的日志落点之后越过了每文件 20 KB 的硬线，
 * 而这次要守住的东西一件都不能删（建成本团队标签的三条理由、失败说明为什么只列全部缺名、
 * 为什么只在权限被拒时才建议手工建）。拆法按「碰不碰网络里的哪一件事」切：本文件只回答
 * 「缺的名字怎么变成一张标签」，`labels.ts` 留着「查一遍、哪些缺、最后怎么整组写回票」。
 * 与同目录 `label-match.ts` 拆出去时同一个理由（见那份文件的头）。
 *
 * 调用关系是单向的：`labels.ts` 依赖本文件，本文件不依赖 `labels.ts`（没有循环）。
 */
import type { OpContext } from '../../contract/contexts.js'
import type { OpResult, TrackerError } from '../../contract/results.js'
import { TRACKER_ERROR_STAGE } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { gql, type LinearAccount } from './client.js'
import { linearError } from './errors.js'
import type { WantedLabel } from './label-match.js'

/** 缺的名字建出来（§4：`IssueLabelCreateInput` 只有 `name` 必填，`color` 不接受 null）。 */
const LABEL_CREATE = 'mutation DeckIssueLabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name color team { id key } } } }'

/** 团队 key → 团队 id：标签的 `teamId` 要 UUID，而绑定声明里写的是 key（与建票同一条路）。 */
const TEAMS_BY_KEY = 'query DeckTeamsByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }'

/**
 * 团队 key → 团队 id。只在真要建标签时才调用，所以「标签全都已经存在」的那一趟不会多一次查询。
 * 声明里没写团队、或者 Linear 没有这个 key，都如实失败：把标签建到凭空猜的团队里，
 * 等于把调用方要的东西换成了别的（与 `write.ts` 建票那一处同一个判断）。
 */
export async function teamIdOfIssue(ctx: OpContext, account: LinearAccount, teamKey: string): Promise<OpResult<string>> {
  if (!String(teamKey || '')) {
    return { ok: false, error: linearError(ERROR_KIND.ENV, 'the workspace binding names no Linear team, so a new label has no team to belong to') }
  }
  const teams: any = await gql<any>(ctx, account, { query: TEAMS_BY_KEY, variables: { key: teamKey }, bucket: 'read' })
  if (!teams.ok) return { ok: false, error: teams.error }
  const nodes = (teams.data && teams.data.teams && teams.data.teams.nodes) || []
  const team = (Array.isArray(nodes) ? nodes : []).find((node: any) => node && String(node.key || '').toUpperCase() === String(teamKey).toUpperCase())
  if (!team || !team.id) {
    return { ok: false, error: linearError(ERROR_KIND.NOTFOUND, 'Linear has no team with key ' + teamKey + ', so a new label cannot be scoped to it') }
  }
  return { ok: true, data: String(team.id) }
}

/**
 * 建一个缺失的标签，回它的 id。
 *
 * **建成本团队的标签，不是工作区标签**，这是这一族唯一一处主动选边的地方，理由三条：
 * 一是这张票属于绑定声明那一个团队，本团队标签它一定能用，而工作区标签只解决「能用」、不解决归属；
 * 二是工作区标签对整个工作区永久可见，一个只为这张票起的名字从此出现在每个团队的选片器里 ——
 * 一次只认一张票的写操作不该有这么大的影响面（还要工作区级的权限才收得回来）；
 * 三是反过来的代价很小：别的团队真要用这个名字时，建自己的那一份即可，两条同名标签并存在 Linear 里
 * 本来就是合法状态，读侧按名字认识它们（`normalize.ts` 的 `issueTypeOf` 只看名字）。
 * 真要建工作区标签，`IssueLabelCreateInput` 的写法是**省掉 teamId**（§4 的原话 “Omit for a workspace
 * label.”），也就是说「建团队标签」是显式给出 teamId 这一条，而不是另有一个 organization 字段
 * （§4 明确说两个输入类型上都没有 organizationId）。
 */
export async function createLabel(ctx: OpContext, account: LinearAccount, want: WantedLabel, teamId: string): Promise<OpResult<string>> {
  const input: Record<string, unknown> = { name: want.name, teamId }
  // §4：color 不接受 null，所以「没颜色」只能整格省掉，不能传空串或 null。
  if (want.color) input.color = want.color
  if (want.description) input.description = want.description
  const created: any = await gql<any>(ctx, account, { query: LABEL_CREATE, variables: { input }, bucket: 'write' })
  if (!created.ok) return { ok: false, error: created.error }
  const payload = created.data && created.data.issueLabelCreate
  const id = payload && payload.issueLabel ? String(payload.issueLabel.id || '') : ''
  if ((payload && payload.success === false) || !id) {
    return { ok: false, error: linearError(ERROR_KIND.CONFLICT, 'Linear accepted the label creation but reported no label id, so the ticket was left untouched') }
  }
  return { ok: true, data: id }
}

/**
 * 把「建标签失败」补成一条人能照着做的失败（#85）。
 *
 * 为什么要补：Linear 的应用令牌在有的工作区没有建标签的权限，回的只有一句 “not allowed to take action”，
 * 而回执里 `stage` 为空、reason 是 backend-unsupported，读的人看不出是标签这一步失败、缺哪些标签、该做什么。
 * 这里不新增原因码（原因码固定八个，见 `receipt-reason.ts`），而是把事实写进两处：
 *   · 失败的 `stage` 字段标成 `LABEL_CREATE`，让失败证据里看得见是哪一步；
 *   · `message` 写明这一步、Linear 的原话，权限被拒时再列出**还没建成的全部名字**（被拒的这个加上还没试的），
 *     并说清去哪里一次性建好再重试。只列被拒的那一个不够：人会建一个、重试、再撞下一个。
 * `kind` 原样保留（权限被拒仍是 `auth`）：分类决定界面怎么说话，这里只补说明，不改分类。
 * 只有权限被拒才建议「去 Linear 里手工建」：别的原因（比如名字不合规）手工建同样会失败，那句话会把人带偏。
 * 已经建出来的标签留在工作区里，理由见 `createLabel`。
 */
export function labelCreateFailure(cause: TrackerError, stillMissing: WantedLabel[], teamKey: string): TrackerError {
  // stillMissing 的第一个就是这次建失败的那个标签，后面是还没试的。
  const head = 'The step of creating a label failed: the label "' + stillMissing[0].name + '" was not created (Linear said: ' + cause.message + '). '
  const tail = cause.kind === ERROR_KIND.AUTH
    ? 'Missing labels that could not be created: ' + stillMissing.map((item) => '"' + item.name + '"').join(', ')
      + '. No ticket was created or changed. Create them once in Linear (Settings, Labels, team ' + teamKey + ') and retry.'
    : 'No ticket was created or changed.'
  return { kind: cause.kind, message: head + tail, raw: cause.raw || cause.message, stage: TRACKER_ERROR_STAGE.LABEL_CREATE }
}

/**
 * src/tracker/session/repo-ref-note.ts —— 仓库身份没补全时「怎么说」这一半（#22）。
 *
 * 为什么从 repo-ref.ts 分出来：那个文件管「补全的四步级联」，这个文件管「没补全时面向人的那句话」。
 * 两件事各自改的理由不同（改措辞不该碰补全逻辑），而且 repo-ref.ts 已经贴着 20 KB 的分文件阈值。
 *
 * 两条纪律：
 *  1. 绝不把工作区目录名写成仓库标识。GitHub 的 `describe` 只拿到目录时回的是
 *     `{refId: '', name: 'dsh-skills-deck'}`——`name` 是目录名，不是身份。把它当 id 印出来，
 *     「没解析出仓库」就会读成「仓库解析到了、只是 refId 丢了」，排查方向被带到 keyring 的 token 上。
 *  2. 认不出原因就回 `repo-ref`，不猜。
 */
import type { RepositoryRef } from '../contract/entities.js'

/**
 * 补齐结果的形状：本文件只读两格（身份、每一步的诊断）。
 *
 * 为什么不直接引 `repo-ref.ts` 里的 `RepoRefResolution`：`src/tracker` 里同一层的干活文件
 * 不许互相 import（门禁 `same-layer-import-tracker`），而这里要的是结构、不是那一份实现。
 * 按结构声明的另一头好处是：`resolveSessionRepoRef` 的返回值天然对得上，调用方不必转换。
 */
export interface RepoRefResolutionLike {
  /** 补齐到的身份；连壳都没有时是 null。 */
  ref?: RepositoryRef | null
  /** 这次身份从哪来（本文件不读它，留着是为了与真形状对得上、调用方不必转换）。 */
  via?: string
  /** 每一步的结局（按执行顺序）；本文件只读 ok 与 error 两格。 */
  steps?: Array<{ step: string; ok: boolean; error?: string }>
}

/** 身份没补全的原因档位：日志的 `errorKind` 用它，回执照旧写整句。 */
export type RepoRefFailureClass = 'quota-rest' | 'quota-graphql' | 'quota-both' | 'repo-ref'

/** 读一个身份里的 refId（缺格、非字符串都按空串；下游只认这一个判据）。 */
function refIdOf(ref: RepositoryRef | null | undefined): string {
  try {
    const value = (ref as { refId?: unknown } | null | undefined)?.refId
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/**
 * 把一次补齐的结果写成一句人话，给工具回执与插件日志共用。
 *
 * 拿到 refId 就回空串：没出事的时候，回执上不该多一行没人要的注解。
 * 没拿到时说清两件事——「没解析出仓库身份」与「最后一次失败的原因」——原因按执行顺序把 steps 里
 * 带说明的那几步拼起来（一趟最多三步，不会长到读不下去）。这样 REST 见底时回执说的是
 * 「REST requests 见底、约几点恢复」，而不是让人去查 keyring 里的 token。
 */
export function repoRefNoteOf(res: RepoRefResolutionLike | null | undefined): string {
  if (!res) return ''
  if (refIdOf(res.ref)) return ''
  const steps = Array.isArray(res.steps) ? res.steps : []
  const causes: string[] = []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step && step.ok === false && typeof step.error === 'string' && step.error) causes.push(step.error)
  }
  const head = 'No repository identity was resolved'
  return causes.length > 0 ? (head + ': ' + causes.join('; ')) : (head + ' (no locator answered)')
}

/**
 * 把 `repoRefNoteOf` 那句人话归成一个短档位，给日志用。
 *
 * 为什么这里要按文字归类：额度闸的拒绝句是唯一说得出「哪一族见底」的地方，而它只以文字出现
 * （`exhaustedMessage` / `exhaustedAnyMessage`，见 `src/refresh/kernel/budget-admission.ts`）。
 * 把族名做成结构化字段要改裁决的回包形状，那是另一张票的范围（#22 的 Boundaries 写明不动预算模型）。
 *
 * 认不出就回 `repo-ref`：日志里读到它，意思是「身份没补上，具体原因看回执」，而回执永远带着闸的原话。
 * 改那两句文案的人要把这里一并改——它与那两句是一对。
 */
export function repoRefNoteClass(note: string): RepoRefFailureClass {
  const text = String(note || '')
  if (!text) return 'repo-ref'
  if (text.indexOf('both insufficient') >= 0) return 'quota-both'
  if (text.indexOf('REST requests') >= 0) return 'quota-rest'
  if (text.indexOf('GraphQL points') >= 0) return 'quota-graphql'
  return 'repo-ref'
}

export default { repoRefNoteOf, repoRefNoteClass }

// src/tracker/kernel/issue-tracker-declaration.ts —— 主锚 docs/agents/issue-tracker.md 的结构化解析（纯函数）。
//
// 为什么住在内核（#1555）：这份解析有两个读者 —— 判定层（explicitDetector / backendDecision）与
// 后端房间的认领（GitLab 的 matches 要判断「这份文件声明的是不是 GitLab」）。房间只许引内核与契约，
// 所以它从 detection/ 搬进 kernel/；detection/parseIssueTracker.ts 留成转出口，旧引用一条都不用改。
// 判定层与房间因此共用同一套「什么算声明」的口径，不会各写一份正则、各说一套。
//
// 第一性原理（#149 R + #150 Q1/Q6 + 契约 §2 + #113 D1/D6）：
//  - 主锚 = docs/agents/issue-tracker.md（技能集唯一后端指针；人读模板非机器配置，Q4 不回写）
//  - 本模块为纯函数（text→结构）：不读 fs、不碰 process.env / path.join、不抛；
//    I/O 由调用方经 platform.fs 完成。
//  - 契约 §2 capability-by-fill：解析只产「有/无」二分，不产能力表。
//
// 修复 #277（标题优先 + markdown 仅看标题行）：
//  - 标题三者先互斥按 gitlab > markdown > github 收敛并以 high 返回，彻底阻断正文 markdown/.scratch 抢先
//  - 正文关键词仅 low 兜底，且 markdown 正文不参与判定（正文含 markdown/.scratch 不再误切 markdown）
//  - 旧文档无标题时仍可由 gitlab/github 正文兜底；markdown 无标题旧文档由 matches 阶段经 .scratch 目录探测（非 explicit）
//
// #94（补上 linear 的标题行判据）：
//  - 真机现场是一个 Linear 工作区（`# Issue tracker: linear` 在第一行，正文写着「GitHub Issues ... are not the tracker」）。
//    本文件当时没有 linear 的标题判据，于是那一行只能落到正文关键词那一档（low 的 github），判定层按 ADR 20261027
//    只把它当证据、不产结论；自动识别随后同时看见 GitHub（远端）与 Linear（房间读 alias 行），
//    openTracker 依规则拒成 multi-match，整个工作区的票都读不到。病根是两个读者读同一份文件、说法不一致。
//  - 修法是给 linear 同形状的标题判据，让它也进「标题行 = 身份」那一档，绝不 import 房间、也不改认领层的规则。
//  - 标题行优先于正文关键词这一条不变（ADR 20261027）：正文写「GitHub Issues 不是票仓」不产生任何结论。
//
// #1555 补一条给调用方的约定（不改本文件的解析结果）：matches 这类「身份认领」只认 high（标准标题行），
// 不拿 low 的正文兜底去参与多命中；low 兜底留给判定层用 —— 判定层本来就排在自动识别之前，
// 不需要认领再猜一遍。为什么不能让 low 参与认领：正文里只要出现一次 gitlab 字样就会被拉进多命中，
// 那正是这张票的真机现场。

/** 主锚解析结果：显式后端声明加判据说明。调用方只读 backendId 与置信度，其余供排查。 */
export interface ParsedIssueTracker {
  explicitBackendId: string | null
  rawHint: string
  confidence: 'high' | 'low' | 'none'
  reason: string
}

/**
 * 将 docs/agents/issue-tracker.md 文本结构化为显式后端声明。
 * 入参收成未知值：上游读文件可能交来空值，内部统一转成字符串再判。
 * @param raw 主锚文本（BOM/字面 \n 已由 normalizeTrackerText 处理，此处只做 Trim/BOM 清理）
 */
export function parseIssueTracker(raw: unknown): ParsedIssueTracker {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim()
  if (!text) return { explicitBackendId: null, rawHint: '', confidence: 'none', reason: 'empty' }

  // 显式标题形态 `# Issue tracker: GitHub` 为 high 置信 — 仅标题行参与 high 判定
  const titleGithub = /^#\s*issue\s*tracker\s*:\s*github/im.test(text)
  const titleGitlab = /^#\s*issue\s*tracker\s*:\s*gitlab/im.test(text)
  const titleMarkdown = /^#\s*issue\s*tracker\s*:\s*(markdown|local)/im.test(text)
  // #94：Linear 房读的是同一份文件、同一种形状的标题行（`# Issue tracker: linear`）。
  // 判定层从前没有这一条，同一份文件就被两个读者读成两个答案：房间说「这是 Linear」，判定层说「没有结论」。
  // 这里只认标题行，不看 alias —— 缺 alias 的声明仍是 Linear 工作区（房间随后用 #65 的提示要人补上），
  // 若因为缺 alias 就在这里退回普通工作区，人会被静默送到 GitHub 那个错误的后端去。
  const titleLinear = /^#\s*issue\s*tracker\s*:\s*linear/im.test(text)

  // ── 第一阶段：标题优先（高置信），优先级 gitlab > markdown > github > linear ──
  if (titleGitlab) {
    return { explicitBackendId: 'gitlab', rawHint: 'gitlab', confidence: 'high', reason: 'title-gitlab' }
  }
  if (titleMarkdown) {
    return { explicitBackendId: 'markdown', rawHint: 'markdown', confidence: 'high', reason: 'title-markdown' }
  }
  if (titleGithub) {
    const ghHint = /gh\s+(issue|api|auth)|github\s*issues/i.test(text)
    return { explicitBackendId: 'github', rawHint: 'github', confidence: 'high', reason: ghHint ? 'github-template' : 'title-github' }
  }
  // linear 排在这一档的最后。这个位置不表达「谁更可信」—— 四者之间的次序只是为了给
  // 「一份文件写了多个一级标题声明」这种畸形文档一个确定的答案（正常文档只有一个一级标题，
  // #94 的真机文档就是 linear 在第一行、它上面没有任何别的标题，排在哪里都命中）。
  // 但它也不许随便挪：本仓库自己的 docs/agents/issue-tracker.md 第一行声明 GitHub，文末又用一个
  // `# Issue tracker: linear` 演示 Linear 那一节长什么样（含 alias 示例）；把 linear 提到 github 前面，
  // 这段演示文本就会把 deck 自己的工作区判成 Linear。改这个次序之前先看那道门禁
  // tests/verify-94-linear-declaration-heading.ts 的 F 段。
  if (titleLinear) {
    return { explicitBackendId: 'linear', rawHint: 'linear', confidence: 'high', reason: 'title-linear' }
  }

  // ── 第二阶段：标题均未命中时，正文关键词 low 兜底 ──
  // markdown 正文关键词已按 #277 建议彻底忽略（仅看标题行），避免 "# Issue tracker: GitHub" + 正文 markdown/.scratch 误判；
  // markdown 旧文档无标题时由 matches 阶段经 .scratch 目录探测，无需 explicit 低兜底。
  const hasGitlab = /gitlab/i.test(text)
  if (hasGitlab) {
    return { explicitBackendId: 'gitlab', rawHint: 'gitlab', confidence: 'low', reason: 'keyword-gitlab' }
  }
  const hasGithub = /github/i.test(text)
  if (hasGithub) {
    const ghHint = /gh\s+(issue|api|auth)|github\s*issues/i.test(text)
    return { explicitBackendId: 'github', rawHint: 'github', confidence: 'low', reason: ghHint ? 'github-template' : 'keyword-github' }
  }

  return { explicitBackendId: null, rawHint: '', confidence: 'none', reason: 'no-keyword' }
}

/**
 * 小工具：对已读文本判空并去 BOM（与 host normalizeBody 互补）。
 * 入参收成未知值：空值统一按空串处理，不抛异常。
 */
export function normalizeTrackerText(raw: unknown): string {
  if (raw == null) return ''
  let s = String(raw).replace(/^\uFEFF/, '')
  // 字面 \n 还原仅在大量字面换行聚类时才触发（与 host normalizeBody 同阈值）
  const realNL = (s.match(/\n/g) || []).length
  const literalNL = (s.match(/\\n/g) || []).length
  if (realNL < 2 && literalNL > 0) s = s.replace(/\\n/g, '\n')
  return s
}

export default parseIssueTracker

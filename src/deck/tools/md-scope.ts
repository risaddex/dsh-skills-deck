// src/deck/tools/md-scope.ts —— 本地 Markdown 后端的「工作单元目录」参数（#1480 T2）
//
// 为什么要两个参数：Matt 原文里两套技能用两个词叫同一个物理位置——
//   · 规格、实施票、普通票住在 `.scratch/<feature-slug>/`（issue-tracker-local.md:7-9）；
//   · 探索地图与它的子票住在 `.scratch/<effort>/`（同文件 :25-28）。
// 工具面对 AI 时按场景给词：建/碰规格体系用 feature，碰探索地图用 effort。落到契约里仍然是同一个
// 寻址范围 `RepositoryRef.effortId`（本地后端 = `.scratch/` 下的目录名）；GitHub / GitLab 只有一个
// 隐含工作单元，照旧忽略这两个参数。内部字段名 effortId 不动：契约、快照键与工作路线都靠它。
//
// 不能改的约定：
//   1. 两个参数互斥。两个都填说明调用方没分清这次在哪套技能里，直接拒绝，不替它猜。
//   2. 目录名只能是单段：不许路径分隔符、不许 `.` / `..`、末尾不许点或空格。这个值要直接拼进
//      `<cwd>/.scratch/<目录>/`，放行 `../x` 就会把票写到工作区外面去。
//   3. 改了文案要同步改 tests/verify-1106-deck-surface.ts 的冻表：那份表盯着模型看到的字。
//   4. 参数说明按「建票类」与「查改类」两套给（区别只在「不填时怎么办」），别再复制第三份。

/** 收口后的结果：成功时 effortId 是 `.scratch/` 下的目录名（空串 = 不限定），scene 记调用方用哪个词。 */
export type MdScope = { ok: true; effortId: string; scene: '' | 'effort' | 'feature' } | { ok: false; message: string }

type StringParam = { type: 'string'; description: string }

/** 建票类工具的两个参数：目录不填时由父票或标题决定。 */
export const MD_SCOPE_CREATE: Record<'effort' | 'feature', StringParam> = {
  effort: {
    type: 'string',
    description: 'Local Markdown backend only: the name of the `.scratch/` directory that holds the exploration map (wayfinder), called `<effort>` in the original text. When it is not given, the directory is decided by the parent ticket or the title; remote backends ignore it.',
  },
  feature: {
    type: 'string',
    description: 'Local Markdown backend only: the name of the `.scratch/` directory that holds specs, spec tickets and plain tickets, called `<feature-slug>` in the original text. When it is not given, the directory is decided by the parent ticket or the title; remote backends ignore it.',
  },
}

/** 查/改类工具的两个参数：目录不填就查整个仓库。 */
export const MD_SCOPE_LOCATE: Record<'effort' | 'feature', StringParam> = {
  effort: {
    type: 'string',
    description: 'Local Markdown backend only: the name of the `.scratch/` directory that holds the exploration map (wayfinder), called `<effort>` in the original text. When it is not given, the whole repository is searched; remote backends ignore it.',
  },
  feature: {
    type: 'string',
    description: 'Local Markdown backend only: the name of the `.scratch/` directory that holds specs, spec tickets and plain tickets, called `<feature-slug>` in the original text. When it is not given, the whole repository is searched; remote backends ignore it.',
  },
}

/** 目录名里不能出现的东西：返回一句人话原因，能用就返回空串。 */
function badDirName(name: string): string {
  if (name === '.' || name === '..') return 'it means the current directory or the parent directory'
  // 路径分隔符与 Windows 保留字符：拼进路径后会变成另一条路，或者写不出来。
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return 'it contains a path separator or a character a file name does not allow'
  // Windows 会把结尾的点和空格吞掉，导致「以为写了 A、实际落在 A」。
  if (/[. ]$/.test(name)) return 'it ends with a dot or a space (Windows drops that)'
  return ''
}

/**
 * 把模型给的两个参数收成一份寻址范围：两个都填 → 拒绝；目录名不安全 → 拒绝；
 * 都没填 → 不限定（返回 ok，effortId 为空串）。选择困难时不猜，把话说明白让它重填。
 */
export function readMdScope(a: Record<string, unknown>): MdScope {
  const effort = typeof a.effort === 'string' ? a.effort.trim() : ''
  const feature = typeof a.feature === 'string' ? a.feature.trim() : ''
  if (effort && feature) {
    return {
      ok: false,
      message: 'Give only one of effort and feature: both name the same directory under `.scratch/` on the local backend, and only the two sets of original skills call it differently (the exploration map says `<effort>`, the spec system says `<feature-slug>`). Keep whichever one this call is about; giving both makes the reader guess which one you mean.',
    }
  }
  const name = effort || feature
  if (name) {
    const bad = badDirName(name)
    if (bad) {
      return {
        ok: false,
        message: 'The directory name cannot be "' + name + '": ' + bad + '. This value is pasted straight into `.scratch/<directory>/`, so it only accepts a single plain directory name (for example buy-coffee or coffee-points).',
      }
    }
  }
  return { ok: true, effortId: name, scene: effort ? 'effort' : (feature ? 'feature' : '') }
}

/**
 * 工具入口统一用这一份：收参数、校验、把目录名落到 repo.effortId 上，一次做完。
 * 八份工具各抄一遍这段会很快走散；参数含义、拒绝话与回执 note 都只在这里改。
 */
// repo 的类型写成 effortId?: unknown：工具壳里的 DeckRepo 把 effortId 声明成 unknown（它还要被
// 各种后端读，不在这里收窄），这里只负责把它填成校验过的字符串，所以入参要比 DeckRepo 宽。
export function applyMdScope(repo: { effortId?: unknown; mdScene?: unknown }, a: Record<string, unknown>): MdScope {
  const got = readMdScope(a)
  if (!got.ok) return got
  if (got.effortId) repo.effortId = got.effortId
  // #1486：后端读 00 号时要分清这次说的是 feature（找 spec.md）还是 effort（找 map.md）；
  // 只把目录名传下去不够，两套原文用同一个 00 指两种容器。
  repo.mdScene = got.scene
  return got
}

/** 回执里那句人话：说清这次用的是哪个词、本地后端把范围收在哪，免得以为远端也会跟着变。 */
export function mdScopeNote(scene: string, effortId: string): string {
  const word = scene === 'effort' ? 'effort (the exploration map directory)' : (scene === 'feature' ? 'feature (the spec system directory)' : 'work unit directory')
  return 'This call carried ' + word + ' "' + effortId.slice(0, 60) + '": the local backend looks only inside that one `.scratch/` directory, and remote backends ignore it.'
}

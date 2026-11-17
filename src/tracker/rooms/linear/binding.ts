/**
 * src/tracker/rooms/linear/binding.ts —— 读仓库自己的 Linear 绑定声明（#27 的决定第 2、4 条）
 *
 * 一个工作区用哪本账是**仓库的声明**，不是宿主的配置：声明写在 `docs/agents/issue-tracker.md` 里，
 * 与 GitHub 那一节同一个文件、同一种写法。房间读它拿到别名（再去问账号缝），也靠它回答
 * 「这个工作区是不是 Linear」—— 没配账号不等于不是 Linear：认领了再失败，才能把人送去登录。
 */
import type { OpContext } from '../../contract/contexts.js'

/** 绑定声明里本房用到的三格；缺 alias 视为没写这份声明。 */
export interface LinearBinding {
  /** 账号别名，主线：一条工作区用哪一本账。 */
  alias: string
  /** 团队 key（例如 ENG）；可选，用不上时为空串。 */
  team: string
  /** 项目名；可选。 */
  project: string
}

/** 绑定声明住在这个路径（相对工作区根）。与 GitHub 房共用同一份文档。 */
export const BINDING_PATH = 'docs/agents/issue-tracker.md'

/**
 * 从文档正文里抠出 Linear 那一节。
 *
 * 判据只有一条：`# Issue tracker: linear` 这个二级以上的标题（大小写不敏感），到下一个同级标题为止。
 * 节内认 `alias:` / `team:` / `project:` 三行（冒号可有可无、大小写不敏感）。
 * 认不出 alias 就当没这份声明 —— 半份声明比没有更危险：它会让房间以为有账可用了。
 */
export function parseBinding(text: string): LinearBinding | null {
  const lines = String(text || '').split(/\r?\n/)
  let inside = false
  const found: Record<string, string> = {}
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim())
    if (heading) {
      const title = heading[2].replace(/\s+/g, ' ').trim().toLowerCase()
      if (inside) break
      if (title === 'issue tracker: linear') { inside = true; continue }
      continue
    }
    if (!inside) continue
    const pair = /^\s*[-*]?\s*(alias|team|project)\s*[:：]\s*(.+?)\s*$/i.exec(line)
    if (pair) found[pair[1].toLowerCase()] = pair[2]
  }
  const alias = String(found.alias || '').trim()
  if (!alias) return null
  return { alias, team: String(found.team || '').trim(), project: String(found.project || '').trim() }
}

/**
 * 读当前工作区的声明。读不到（没有文件、没有沙箱、解析不出别名）一律回 null —— 那是「不是 Linear」
 * 的诚实答案，不是错误：GitHub/GitLab 工作区本来就没有这一节。
 */
export async function readBinding(ctx: OpContext): Promise<LinearBinding | null> {
  try {
    const path = await ctx.fs.resolve(BINDING_PATH, { cwd: String((ctx as any).cwd || '') })
    const text = await ctx.fs.readText(path)
    return parseBinding(text)
  } catch { return null }
}

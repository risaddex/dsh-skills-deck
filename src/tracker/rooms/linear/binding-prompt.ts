/**
 * src/tracker/rooms/linear/binding-prompt.ts — the setup prompt of a Linear workspace that has no binding yet (#65, option C)
 *
 * The status bar banner asks the host for this text and injects it into the session. The plugin itself does not
 * write `docs/agents/issue-tracker.md` (the repository's "no write-back" rule stays): the agent writes the file,
 * and this prompt gives it the EXACT section text, built by the same code the gate reads back with `parseBinding`.
 *
 * Alias rule: with exactly one configured account the prompt proposes it and carries the exact section for it.
 * With zero accounts, several accounts, or a listing that failed, the prompt carries no alias at all and tells
 * the agent to ask the maintainer which alias to use. Guessing an account for someone is the one thing it must never do.
 *
 * Boundary rule: only `alias`, `label` and `teams` of an account are ever read here (see `publicAliasesOf`).
 * Everything else a seam entry carries is dropped on the first line, so a token-like field cannot reach the text.
 */
import { renderBindingSection } from './binding-write.js'

/** The three fields of a configured account that may reach the prompt. */
export interface PublicAlias {
  alias: string
  label: string
  teams: string[]
}

const ALIAS_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Keep only usable aliases, only the three public fields, each alias once, in the order the seam listed them.
 * An entry without a string alias, with an alias the room would refuse, or a repeated alias is dropped rather than repaired.
 */
export function publicAliasesOf(entries: unknown): PublicAlias[] {
  const out: PublicAlias[] = []
  const seen = new Set<string>()
  if (!Array.isArray(entries)) return out
  for (const entry of entries) {
    const raw = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
    const alias = raw && typeof raw['alias'] === 'string' ? (raw['alias'] as string).trim() : ''
    if (!alias || !ALIAS_PATTERN.test(alias) || seen.has(alias)) continue
    seen.add(alias)
    const label = raw && typeof raw['label'] === 'string' && (raw['label'] as string).trim() ? (raw['label'] as string).trim() : alias
    const teams = raw && Array.isArray(raw['teams']) ? (raw['teams'] as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()) : []
    out.push({ alias, label, teams })
  }
  return out
}

export interface BindingPromptInput {
  aliases: PublicAlias[]
  /** The listing itself failed (as opposed to "no accounts"); the text then says the list is unknown. */
  listFailed?: boolean
  lang?: string
}

/** One configured account as a line the agent can show to the maintainer. */
function lineOf(a: PublicAlias, zh: boolean): string {
  const teams = a.teams.length ? (zh ? '，团队 ' : ', teams ') + a.teams.join('/') : ''
  return '- ' + a.alias + (a.label !== a.alias ? ' (' + a.label + ')' : '') + teams
}

/** The prompt text. Chinese when `lang` is 'zh', English otherwise. */
export function buildBindingPrompt(input: BindingPromptInput): string {
  const zh = (input && input.lang) === 'zh'
  const aliases = publicAliasesOf(input && input.aliases)
  const exact = aliases.length === 1 ? renderBindingSection({ alias: aliases[0].alias }) : ''
  const shape = '# Issue tracker: linear\n\nalias: <' + (zh ? '维护者选定的别名' : 'the alias the maintainer chose') + '>\n'
  const fence = '```markdown\n' + (exact || shape) + '```'
  let account: string
  if (aliases.length === 1) {
    account = zh
      ? '这台机器上只配置了一个 Linear 账号：「' + aliases[0].alias + '」。默认就用它，除非维护者另有说明。'
      : 'This machine has exactly one Linear account configured: "' + aliases[0].alias + '". Use it unless the maintainer says otherwise.'
  } else if (aliases.length > 1) {
    account = (zh
      ? '这台机器上配置了多个 Linear 账号。不要替维护者挑：先问维护者这个工作区用哪个别名（ask the maintainer），拿到答案后再把上面的 <…> 换成它。\n可选别名：\n'
      : 'This machine has several Linear accounts configured. Do not pick one for them: first ask the maintainer which alias this workspace uses, then put it in place of the <...> above.\nConfigured aliases:\n') + aliases.map((a) => lineOf(a, zh)).join('\n')
  } else if (input && input.listFailed) {
    account = zh
      ? '这台机器上已配置的 Linear 账号清单读不出来。先问维护者这个工作区用哪个别名（ask the maintainer），不要猜，也不要去创建账号。'
      : 'The list of Linear accounts configured on this machine could not be read. Ask the maintainer which alias this workspace uses; do not guess one and do not create an account.'
  } else {
    account = zh
      ? '这台机器上没有配置任何 Linear 账号（no Linear account）。先问维护者这个工作区用哪个别名（ask the maintainer），不要猜，也不要自己去创建账号。'
      : 'No Linear account is configured on this machine. Ask the maintainer which alias this workspace uses; do not guess one and do not create an account yourself.'
  }
  if (zh) {
    return [
      '为这个工作区写好 Linear 绑定。只做这一件事。',
      '',
      '1. 打开 docs/agents/issue-tracker.md。如果文件或 docs/agents/ 目录不存在，就 create 它们。',
      '2. 把下面这一节逐字写进去（verbatim：字符一个不改，标题后的空行也要保留）：',
      '',
      fence,
      '',
      '3. 文件已经存在时：除 Linear 这一节以外的每一行都原样保留（keep every other line exactly as it is）。只替换已有的 “# Issue tracker: linear” 一节（从该标题到下一个标题之前）；没有这一节就在文件末尾空一行后追加。不要重写、重排或重新格式化别的内容，也不要碰别的文件。',
      '4. 除非维护者明确给了团队 key 或项目名，否则不要加 team: 或 project: 行。',
      '5. 写完后重新读一遍（re-read）这个文件，确认这一节在，并且 alias 行与上面一字不差；用一句话汇报结果。',
      '',
      account,
    ].join('\n')
  }
  return [
    'Write the Linear binding for this workspace. Do only this one thing.',
    '',
    '1. Open docs/agents/issue-tracker.md. If the file or the docs/agents/ directory does not exist, create the docs/agents/ directory and the file.',
    '2. Write this section verbatim (exactly these characters, including the blank line after the heading):',
    '',
    fence,
    '',
    '3. If the file already exists, keep every other line of it exactly as it is. Replace only an existing "# Issue tracker: linear" section (from that heading up to the next heading); if there is none, append the section at the end after one blank line. Do not rewrite, reformat or reorder anything else, and do not touch any other file.',
    '4. Do not add team: or project: lines unless the maintainer gave you a team key or a project name.',
    '5. After writing, re-read the file and confirm that the section is there and its alias line matches the text above exactly. Report the result in one sentence.',
    '',
    account,
  ].join('\n')
}

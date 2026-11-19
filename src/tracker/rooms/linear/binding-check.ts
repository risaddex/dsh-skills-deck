/**
 * src/tracker/rooms/linear/binding-check.ts — the chain check "this workspace declares its Linear binding" (#65)
 *
 * Why a check of its own, and not the generic `tracker:initialized` file-exists check: that one is satisfied by
 * any `docs/agents/issue-tracker.md`, including a GitHub-style file, so a Linear workspace would count as set up
 * while the room still answers "this workspace has no Linear binding". The only honest question is the one the
 * room asks itself: does `parseBinding` find an alias in that file.
 *
 * The check takes the host platform's file service (the same shape the local Markdown checks take), so the
 * host chain and the gate can run the very same code.
 *
 * Status rules: no file service or no workspace directory is `pending` (unknown, never "fail"); a file that
 * cannot be read or has no valid section is `fail`; a valid section is `pass` and names the alias.
 */
import { BINDING_PATH, parseBinding } from './binding.js'

export interface LinearBindingCheckDeps {
  /** Host platform (anything with `fs.resolve` and `fs.readText`). */
  platform?: unknown
  cwd?: unknown
  /** 'zh' for Chinese text, anything else for English. */
  lang?: string
}

export interface LinearBindingCheckResult {
  status: 'pass' | 'fail' | 'pending'
  detail: string
}

type LooseFs = {
  resolve?: (path: string, opts?: { cwd?: string }) => Promise<unknown>
  readText?: (path: unknown) => Promise<unknown>
}

export async function checkLinearBinding(deps: LinearBindingCheckDeps): Promise<LinearBindingCheckResult> {
  const zh = (deps && deps.lang) === 'zh'
  const cwd = deps && typeof deps.cwd === 'string' ? deps.cwd : ''
  const fs = ((deps && deps.platform) as { fs?: LooseFs } | null | undefined)?.fs
  if (!cwd || !fs || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') {
    return { status: 'pending', detail: zh ? '暂时读不到工作区文件，无法确认 Linear 绑定' : 'The workspace files cannot be read right now, so the Linear binding is unconfirmed' }
  }
  let text = ''
  try {
    const abs = await fs.resolve(BINDING_PATH, { cwd: cwd })
    text = String(await fs.readText(abs))
  } catch {
    return { status: 'fail', detail: zh ? '没有读到 ' + BINDING_PATH + '，工作区还没有 Linear 绑定' : BINDING_PATH + ' could not be read, so the workspace has no Linear binding yet' }
  }
  const binding = parseBinding(text)
  if (!binding) return { status: 'fail', detail: zh ? BINDING_PATH + ' 里没有带 alias 的 “# Issue tracker: linear” 一节' : BINDING_PATH + ' has no "# Issue tracker: linear" section with an alias line' }
  return { status: 'pass', detail: (zh ? 'Linear 账号别名：' : 'Linear account alias: ') + binding.alias }
}

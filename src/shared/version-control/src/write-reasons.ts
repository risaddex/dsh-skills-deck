/**
 * src/shared/version-control/src/write-reasons.ts —— 写操作的失败种类与中文句子（#841，纯函数）
 *
 * 单一真源：宿主只透传 reason 与 hint，不在宿主里另造措辞（#841 硬要求）。
 * 两张表分工：
 *   · 票据类（ticket-missing / ticket-op-mismatch / ticket-expired / stale-head / stale-index /
 *     fingerprint-unavailable / target-changed）由宿主判定，**不看 git 文本**；
 *   · git 文本类由本文件的 classifyWriteFailure 按 op 归类（同一个词在不同 op 下意思不同）。
 * 传输档（need-credentials / auth-rejected / no-permission / network / stalled / timeout /
 * budget-exhausted / spawn-failed / env / args）归 #839 的 hintFor，本文件一个字不重写。
 */
import type { WriteOp } from './ports.js'

/** 写层稳定标识符 → 一句能照着做的中文话。 */
export const WRITE_REASONS: Record<string, string> = {
  'ticket-missing': 'This confirmation has expired (it may already have been used, or the page was reopened). Review it again before clicking.',
  'ticket-op-mismatch': 'This confirmation is not for this action. Review it again before clicking.',
  'ticket-expired': 'The confirmation was not used within 2 minutes and has expired. Review it again before clicking.',
  'stale-head': 'The repository changed after your confirmation (the current commit is no longer the one you reviewed). Review it again before clicking.',
  'stale-index': 'The index changed after your confirmation, so the commit would differ from what you saw. Review it again before clicking.',
  'fingerprint-unavailable': 'The complete index list could not be read (the output was too large or truncated), so the commit cannot run. Stage in smaller groups and retry.',
  'target-changed': 'The operation target (remote/branch/upstream) changed after your confirmation. Confirm again.',
  'stale-repo': 'This confirmation was not issued for this repository (the workspace or directory changed). Review it again before clicking.',
  'head-unreadable': 'This step finished, but the repository state cannot be read to confirm the result. Refresh and check the commit history before deciding.',
  'empty-message': 'The commit message cannot be empty.',
  'message-too-long': 'The commit message is too long (title up to 200 characters, total up to 5000).',
  'bad-paths': 'No files to stage were provided, or the path shape is invalid.',
  'bad-target': 'No usable push target was resolved. Confirm again.',
  'request-reused': 'This requestId was already used for another action: a requestId can replay only the same action, so send again with a new one.',
  'need-remote-choice': 'This repository has several remotes, and the panel will not choose for you. Select a remote and confirm.',
  'no-remote': 'This repository has no remotes. Add one in the sidebar terminal (git remote add), then come back to push.',
  'nothing-to-stage': 'There is nothing to stage.',
  'nothing-staged': 'The index is empty; there is nothing to commit.',
  // —— 提交页（#1743）新增的失败理由：2.4 的目标提交与 2.6 的签名 ——
  'need-commit-target': 'Creating a fixup / squash commit requires selecting a target commit it can be absorbed into.',
  'bad-commit-target': 'This target commit is invalid or no longer exists in the repository. Select another one.',
  'nothing-to-amend': 'This branch has no commits yet, so there is no previous commit to amend.',
  'signing-failed': 'Local signing configuration could not sign this commit (missing key or passphrase, or a gpg error), so the commit did not happen. Check the git commit signing output in the sidebar terminal.',
  'intent-to-add': 'The index contains intent-to-add entries (git add -N). Committing them would use the current working tree content, and the panel will not guess for you. Handle this file in the sidebar terminal.',
  // 拉取被拒时 fetch 那一半已经成功（远端的新提交已经取回来了）——话术要说清这一点，别让用户以为白跑一趟。
  'rejected-by-server': 'The remote rejected this push (a server hook or protection rule blocked it). The panel cannot change remote rules; the line above is the remote message, so follow it.',
  'auth-failed': 'The remote rejects this machine\'s credentials (likely expired or revoked). Sign in again in the right sidebar terminal, then come back.',
  'non-fast-forward': 'New remote commits were fetched, but local history has diverged, so fast-forward is impossible. The panel only fast-forwards; merge or rebase in the sidebar terminal.',
  'conflict': 'Both local and remote have new commits, so pulling directly would conflict. The panel will not merge for you; run git pull in the sidebar terminal and come back after resolving conflicts.',
  'hooks-failed': 'A repository commit hook failed, so the commit did not happen. Run git commit in the sidebar terminal to see the hook output.',
  'head-moved': 'The repository HEAD changed (this commit may have succeeded, or another program committed). Check the commit history before deciding.',
  // —— 改动页（#1742）新增的失败理由 ——
  'bad-path': 'The panel will not operate on this path: it accepts only repository-relative paths with forward slashes, not starting with a hyphen or colon, and without ../, backslashes or absolute paths.',
  'hunks-unavailable': 'git cannot split this file into hunks (binary, pure rename, or no splittable changes); stage or discard the whole file.',
  'hunk-out-of-range': 'The hunk you selected no longer exists (the file changed after confirmation). Review it again before clicking.',
  'nothing-to-do': 'There is nothing to do now (it may already be done, or the working tree is clean).',
  'path-exists': 'A file already exists at the target, and moving would overwrite it. Choose another name and retry.',
  'path-modified': 'This file still has unhandled changes; stage or discard them before deleting it.',
  'ignore-invalid': 'This line cannot be added to the ignore list (it is empty or contains control characters).',
  'operation-in-progress': 'The repository is merging, rebasing, cherry-picking or reverting, so these actions are unavailable. Finish the current operation first.',
  'repo-bare': 'This is a bare repository with no working tree to change.',
  // —— 配置与钩子（#1760）新增的失败理由 ——
  // 这些理由分两类：前六条是「面板自己拒」（不起进程），后三条是「git 那一步没成」。
  // 面板拒的时候要说清为什么，因为用户会觉得「改一个配置而已，凭什么不让我改」。
  'key-readonly': 'The config page changes only the two commit identity keys (name and email); other keys are read-only. Change other keys with git config in the sidebar terminal: the panel is not a general key-value editor because keys such as core.hooksPath and alias.* can run arbitrary code.',
  'scope-invalid': 'Scope must be this repository (--local) or this machine (--global). System config cannot be written.',
  'value-empty': 'The new value cannot be empty. To remove this key, use "Delete config" instead of writing an empty value.',
  'value-too-long': 'The new value is too long (maximum 200 characters).',
  'value-invalid': 'The new value contains line breaks or control characters, which config values cannot store.',
  'email-invalid': 'Invalid email: it needs @ and a dotted domain, with no whitespace.',
  'hook-name': 'Hook names may only use lowercase letters, digits and hyphens, and cannot start with a hyphen.',
  'hook-not-found': 'No file exists for this hook in the repository (the name may be wrong, or the hook is not installed). The panel only runs existing hook files.',
  'hook-version': 'This machine\'s git version cannot run hooks manually (2.36 or newer is required). Run the hook file directly in the sidebar terminal.',
  'config-missing': 'This key has no value in the selected scope, so there is nothing to delete.',
  'config-failed': 'git rejected this config write; the line above is its original message.',
  'hook-failed': 'The hook finished with a nonzero exit code; its output is above. A hook failure does not mean this operation failed; handle it according to the output.',
  // —— 冲突向导（#1747）新增的失败理由 ——
  'conflict-markers': 'This content still has conflict markers (<<<<<<<, =======, >>>>>>>), so the panel blocked it: clean them up before saving or marking resolved.',
  'path-not-conflicted': 'This path is no longer a conflicted file (it may already be handled, or the repository changed). Refresh the conflict list and try again.',
  'side-missing': 'This conflicted file does not have the side you chose (the other side deleted it, or only one side exists). Choose the other side, or keep the deletion.',
  'binary-file': 'This is a binary file, so the panel cannot edit it as text. Choose one whole side, or mark it resolved.',
  'target-missing': 'This branch or commit cannot be found. Refresh the branch list and select again.',
  'version-unsupported': 'This machine\'s git version is too old for this step (merge preview requires 2.38 or newer). Upgrade git and retry.',
  'text-too-large': 'This content is too large (over 1 MiB) for the panel to write back. Handle this file in the sidebar terminal.',
  'wrong-operation': 'Skip does not apply to the current operation (merge has no skip step). Use continue or abort instead.',
  'no-operation': 'No merge, rebase, cherry-pick or revert is in progress, so there is nothing to continue, skip or abort.',
  'unmerged-files': 'Some files are still unresolved. Handle each conflicted file (choose a side, edit the whole file, or mark resolved) before continuing.',
  'bad-side': 'No valid side was selected; select again.',
  'fast-forward-impossible': 'This merge cannot fast-forward (the histories have diverged). Use a normal merge, or rebase in the terminal first.',
  // —— 变基待办页（#1749）新增的失败理由 ——
  'update-refs-on': 'This repository has rebase.updateRefs enabled, so rebasing would move other branch pointers too. The panel will not change repository config for you: run git config --local rebase.updateRefs false in the sidebar terminal, then rebase again.',
  'bad-todo': 'The to-do list is invalid (empty, has duplicate commit ids, or contains a commit outside the to-do window). Refresh the to-do window and arrange it again.',
  'todo-too-long': 'The to-do list may contain at most 200 lines at once; process it in batches.',
  'todo-mismatch': 'The to-do window changed after you arranged it (the base or branch moved), so the replay would differ from what you saw. Refresh the to-do window and arrange it again.',
  'missing-message': 'Some commits marked for rewording have no new message. Fill them in before clicking.',
  'bad-action': 'The to-do list contains an action the panel does not provide (the panel only keeps, rewords, squashes, drops and moves commits). Refresh the to-do window.',
  // —— 维护页整仓重写（#1750）新增的失败理由 ——
  'tool-missing': 'git-filter-repo is not installed on this machine (git cannot find the subcommand). Install it according to its official instructions, then retry; the panel will not install tools for you.',
  'shallow-repo': 'This is a shallow clone (history was truncated), so a full rewrite would be incomplete. Run git fetch --unshallow first, or use a complete clone.',
  'dirty-worktree': 'The working tree has uncommitted changes. A full rewrite rewrites every commit, so commit or stash the changes first.',
  'bad-form': 'The rewrite form was not recognized (remove paths, rename paths, rewrite authors, remove large files, replace text). Select a form again.',
  'bad-rename': 'The path rename entry is invalid: source and target must be relative paths, different from each other, and not repeated. Check each entry.',
  'bad-identity': 'The author identity entry is invalid: provide both name and email, with an email like name@example.com and no angle brackets or whitespace.',
  'bad-threshold': 'The size threshold is invalid: write a positive integer with a unit (k, m, g), such as 10M, 500k or 1G; without a unit it is bytes.',
  'bad-replacement': 'The text replacement entry is invalid: the text to replace cannot be empty, the replacement may be empty, and neither side may contain line breaks or ==>.',
  'too-many-items': 'This form accepts at most 50 entries at once. Split the work and check the result after each run.',
  'backup-failed': 'The full repository backup failed, so the rewrite did not start. Check free disk space, backup directory permissions and whether the parent directory exists, then read the git message.',
  'backup-unreadable': 'The backup finished but its size cannot be read (by contract, the operation cannot continue with partial information). Check the backup path, and redo it on another disk if needed.',
  'temp-unavailable': 'The panel cannot write the temporary instruction file (the system temporary directory is not writable or is full), so this step did not start. Clean the temporary directory or try another machine.',
  'task-start-failed': 'The backup succeeded, but the rewrite task did not start (the long-task channel rejected the request). The backup remains, so you can retry without backing up again.',
  // —— 维护页（#1758）新增的失败理由 ——
  'bad-mode': 'Integrity check has only two modes (default and unreachable objects), and the panel does not recognize this mode. Select again and retry.',
  'unknown-write-failure': 'git reported a failure we do not classify; the line above is its original message.',
}

/** 取一句话；表里没有的按兜底那句（照 Rules 的同一风格，绝不返回空串）。 */
export function writeHintFor(reason: string): string {
  return WRITE_REASONS[String(reason || '')] || WRITE_REASONS['unknown-write-failure']
}

/** 提交信息的两条轻校验（D4）：标题 ≤200、整体 ≤5000；空一律拒绝。 */
export function messageProblem(message: string): string | null {
  const s = String(message === undefined || message === null ? '' : message)
  if (s.trim() === '') return 'empty-message'
  if (s.length > 5000) return 'message-too-long'
  const firstLine = s.split('\n')[0]
  if (firstLine.length > 200) return 'message-too-long'
  return null
}

/** 暂存路径的形状：至少一条、非空、不含 NUL。返回 null 表示没问题。 */
export function pathsProblem(paths: unknown): string | null {
  if (!Array.isArray(paths) || paths.length === 0) return 'bad-paths'
  for (const p of paths) {
    if (typeof p !== 'string' || p === '' || p.indexOf('\u0000') >= 0) return 'bad-paths'
    // 再挡两类会被 git 当别的东西解释的形状（写侧输不起）：'-x.txt' 会被当未知开关，
    // ':(exclude)*.txt' 是 pathspec 魔法（--literal-pathspecs 已关掉魔法与通配，这里补一道）。
    if (p.charAt(0) === '-' || p.charAt(0) === ':') return 'bad-paths'
  }
  return null
}

/** git 文本 → 写层 reason；按 op 分（同一个词在不同 op 下意思不同），认不出回兜底。 */
export function classifyWriteFailure(op: WriteOp, exitCode: number, stderrText: string): string {
  if (exitCode === 0) return 'unknown-write-failure'
  const t = String(stderrText || '').toLowerCase()
  // 冲突向导（#1747）的几个动作不是 WriteOp 的联合成员，这里按动作名先分一支。
  // 合并类的「冲突」不是失败：执行层把它当成功结果（工作区留下冲突等用户处理），只有真正的拒绝才走到这里。
  const opName = String(op || '')
  if (opName === 'merge' || opName === 'merge-ff-only' || opName === 'merge-no-ff' || opName === 'merge-squash') {
    if (/not possible to fast-forward/.test(t)) return 'fast-forward-impossible'
    if (/not concluded your merge|you have not concluded your merge|merging is not possible/.test(t)) return 'operation-in-progress'
    return 'unknown-write-failure'
  }
  if (opName === 'take-side' || opName === 'mark-resolved' || opName === 'save-file') {
    if (/does not have (their|our) version/.test(t)) return 'side-missing'
    if (/did not match any files|pathspec .* did not match/.test(t)) return 'bad-path'
    return 'unknown-write-failure'
  }
  if (op === 'commit') {
    // 顺序有意义（#1743）：签名失败、无可修订提交、目标提交不存在各有自己的话术，
    // 都要排在「没有暂存内容」「钩子拒绝」这些通用分类之前，否则会被兜底吞成笼统的一句。
    if (/gpg failed to sign|failed to sign the data|gpg: signing failed|secret key not available|no secret key|gpg: .*failed|signing failed/.test(t)) return 'signing-failed'
    if (/nothing to amend|no commits on branch|no commit to amend/.test(t)) return 'nothing-to-amend'
    if (/could not lookup commit|unknown revision or path not in the working tree|bad revision/.test(t)) return 'bad-commit-target'
    if (/nothing to commit|no changes added to commit|nothing added to commit/.test(t)) return 'nothing-staged'
    // 词表收紧（对抗审查：原来只写 /hook/ 会把任何含 hook 字样的失败都算钩子）：必须真的是钩子拒绝。
    // exitCode === 0 已在函数开头排除，所以这里不用再判一次退出码。
    if (/pre-commit hook|commit-msg hook|prepare-commit-msg hook|hook declined|hook exited|hook failed|by a hook|husky|lint-staged/.test(t)) return 'hooks-failed'
    return 'unknown-write-failure'
  }
  if (op === 'pull') {
    if (/not possible to fast-forward|fatal: not possible to fast-forward/.test(t)) return 'non-fast-forward'
    if (/conflict|automatic merge failed|fix conflicts/.test(t)) return 'conflict'
    return 'unknown-write-failure'
  }
  if (op === 'push') {
    // 顺序有意义：先认「服务端拒绝」与「认证/权限」，再认快进，最后才回兜底。
    // 反面教材（对抗审查真样本）：`pre-receive hook declined` + `failed to push some refs` 曾经被
    // 兜底吞成 non-fast-forward，界面会说「远端有新提交，去合并/变基」——方向完全错。
    if (/remote rejected|hook declined|pre-receive|denied by|remote: error/.test(t)) return 'rejected-by-server'
    if (/authentication failed|could not read username|could not read password|permission denied|403 forbidden|terminal prompts disabled|invalid username or password/.test(t)) return 'auth-failed'
    if (/non-fast-forward|fetch first|rejected.*non-fast-forward/.test(t)) return 'non-fast-forward'
    // 兜底不再猜方向：`[rejected] / failed to push some refs` 是所有推送失败的公共横幅，
    // 单独出现时说不出是哪一种，就如实回兜底（话术带 git 原话）。
    return 'unknown-write-failure'
  }
  // 改动页（#1742）：这几条命令的失败原文很固定，能认出的就认出来，认不出如实回兜底带 git 原话。
  if (op === 'stage-hunks' || op === 'stage-file' || op === 'stage-all' || op === 'unstage') {
    if (/did not match any files|pathspec .* did not match|not under current directory/.test(t)) return 'bad-path'
    return 'unknown-write-failure'
  }
  if (op === 'discard-file' || op === 'discard-all') {
    if (/did not match any file\(s\) known to git|pathspec .* did not match/.test(t)) return 'nothing-to-do'
    return 'unknown-write-failure'
  }
  if (op === 'clean-untracked') {
    if (/no pathspec|did not match any files/.test(t)) return 'nothing-to-do'
    return 'unknown-write-failure'
  }
  if (op === 'rm-tracked' || op === 'rm-cached') {
    if (/has staged content different|has local modifications/.test(t)) return 'path-modified'
    if (/did not match any files|pathspec .* did not match/.test(t)) return 'nothing-to-do'
    return 'unknown-write-failure'
  }
  if (op === 'mv') {
    if (/destination exists|already exists/.test(t)) return 'path-exists'
    if (/bad source|not under version control|did not match any files/.test(t)) return 'bad-path'
    if (/has local modifications|staged content different/.test(t)) return 'path-modified'
    return 'unknown-write-failure'
  }
  return 'unknown-write-failure'
}

/** 票据 id 的形状：非空、≤64 字符、只允许 [A-Za-z0-9_-]。
 *  id 由宿主生成、客户端原样回传，所以它是**外部输入**：不合形状当场拒，不去查表、不起任何进程
 *  （威胁面 T13）。返回 null 表示形状没问题。 */
export function idShapeProblem(id: string): string | null {
  const s = String(id === undefined || id === null ? '' : id)
  if (s === '' || s.length > 64 || !/^[A-Za-z0-9_-]+$/.test(s)) return 'ticket-missing'
  return null
}

export const WRITE_REASONS_SOURCE = 'src/shared/version-control/src/write-reasons.ts'

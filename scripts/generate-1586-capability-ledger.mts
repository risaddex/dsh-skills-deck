#!/usr/bin/env node
// scripts/generate-1586-capability-ledger.mts --- 版本管理页能力账本的生成器（#1737 票 T02 立，规格 #1586）
//
// 生成什么：src/shared/version-control/src/capability-ledger.ts --- 规格第 11 节 162 条能力矩阵的
// 单一数据源。界面渲染、命令面板、覆盖验收与测试都从这份账本读，不在别处再抄一份 id、名称、
// 命令原文或统计数字。
//
// 为什么由生成器写出、而不是直接手写账本：账本是「规格矩阵 + 原型数据 + 页面/版本/替代路径三张
// 对照表」拼出来的派生文件。手写会漏、会飘，改一条要同时改五处；放在生成器里，数据表改一行，
// 重跑一次就对。门禁 tests/verify-1586-capability-ledger.ts 会跑 --check，对不上就是红。
//
// 数据从哪来（没有外部文件可读，生成器自带这几张表；改规格时两边一起改并重跑）：
//   · LAYOUT：逐字抄自规格 #1586 第 11 节「能力矩阵（162 条逐条落点）」的表格，列 =
//     能力号 | 能力 | git 命令（原文） | 级别 | 落点 | 终局 | 主入口 | 研究依据；级别与落点取
//     #1590 原型数据，名称、命令原文、终局、主入口、研究依据取规格矩阵。
//   · VERSION_NOTES：规格第 6 节「版本适配」的已知最低版本与面板降级/隐藏策略；
//   · PANEL_PATHS：规格第 11 节之后那段「面板替代路径」的五行说明；
//   · DOMAINS / PAGES：14 个域的中文名与 16 个页面的登记表（页面按界面结构分页签 / 管理分区 /
//     二级页 / 全局面）。
//
// 与规格怎么对账（评审已接受的口径，别把这段删了）：上面几张表是实施时逐字抄自规格正文的，
// 属于 T02 的既定设计——生成器没有把规格正文当机器可读的输入。所以 --check 证明的是「账本与
// 这几张表一致」，不证明「表与规格一致」：规格矩阵改了，人要同时改本文件的表与规格原文，再重跑
// 生成器和门禁；只改一边，账本门禁仍会绿。把规格正文解析成唯一输入、自动对账，是另一件工程，
// 不在 #1586 范围内。
//
// 用法（在仓库根目录跑）：
//   node scripts/generate-1586-capability-ledger.mts            按数据表重写账本；
//   node scripts/generate-1586-capability-ledger.mts --check    只比对不写；对不上退出码 1，
//       门禁与 npm run typecheck 都靠它看门。
//
// 域票扩展点（#1738 起的实施票）：账本只描述「有哪些能力、落在哪、要什么版本」；具体写命令的
// 判定与解析在 rules.ts / parse-*.ts。给某条能力补实现时不要在这里加行为字段——这里只登记
// 规格矩阵里确实有的列；新增能力必须先改规格矩阵，再改本文件的 LAYOUT 并重跑。
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const ROOT: string = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const LEDGER_REL: string = 'src/shared/version-control/src/capability-ledger.ts'
const GENERATOR_REL: string = 'scripts/generate-1586-capability-ledger.mts'
const OUT_PATH: string = path.join(ROOT, LEDGER_REL)

// 14 个域的中文名：域号就是能力号的前半段，页面与命令面板按这个分组。
const DOMAINS: Record<number, string> = {
  1: "Working tree and staging",
  2: "Commits",
  3: "History",
  4: "Refs and tags",
  5: "History rewriting",
  6: "Merge, rebase and conflicts",
  7: "Stash",
  8: "Remotes and sync",
  9: "Worktrees and parallel checkouts",
  10: "Submodules",
  11: "Repository maintenance and migration",
  12: "Config and hooks",
  13: "Debugging and plumbing",
  14: "Hosting platform and email boundary",
}

// 16 个页面：id | 中文名 | 类型 | 这个页面对应的主入口。每个主入口恰好一个页面，不许有页面没人去。
const PAGES: Array<[string, string, string, string]> = [
  ['changes', "Changes", '页签', '改动页'],
  ['commits', "Commit history", '页签', '提交历史页'],
  ['worktrees', "Worktrees", '页签', '工作树页'],
  ['stash', "Stash", '页签', '贮藏页'],
  ['branch-tags', "Manage · Branches and tags", '管理分区', '分支与管理'],
  ['remote', "Manage · Remotes and sync", '管理分区', '远端与同步'],
  ['submodules', "Manage · Submodules", '管理分区', '管理·子模组'],
  ['maintenance', "Manage · Maintenance", '管理分区', '管理·维护'],
  ['migrate', "Manage · Migration", '管理分区', '管理·迁移'],
  ['config', "Manage · Config", '管理分区', '管理·配置'],
  ['hooks', "Manage · Hooks", '管理分区', '管理·钩子'],
  ['diagnostics', "Manage · Diagnostics", '管理分区', '管理·诊断'],
  ['platform', "Manage · Platform and boundaries", '管理分区', '管理·平台与边界'],
  ['rebase', "Rebase to-do", '二级页', '变基待办'],
  ['conflicts', "Conflict guide", '二级页', '冲突向导'],
  ['search', "Repository search", '全局面', '全库搜索'],
]

// 规格第 6 节「版本适配」的已知最低版本与降级/隐藏策略：能力号 -> [最低版本, 策略, 低版本时的替代说明]。
// 表里没有的能力一律按 2.11 硬底线处理。策略只有两种：degrade（给替代做法）、hide（藏起来）。
const VERSION_NOTES: Record<string, [string, string, string]> = {
  '1.5': ['2.23', 'degrade', "below 2.23, use git reset HEAD -- <path> to unstage"],
  '1.6': ['2.23', 'degrade', "below 2.23, use git checkout -- <path> to discard unstaged changes in this one file"],
  '1.7': ['2.23', 'degrade', "below 2.23, use git checkout -- . to discard all unstaged changes"],
  '4.2': ['2.23', 'degrade', "below 2.23, use git checkout -b to create and switch branches"],
  '4.3': ['2.23', 'degrade', "below 2.23, use git checkout to switch branches"],
  '4.4': ['2.23', 'degrade', "below 2.23, use git checkout <commit> to check out a commit"],
  '5.9': ['2.38', 'hide', "not done in the panel: move branch pointers one by one during interactive rebase"],
  '6.10': ['2.38', 'hide', "merge without preview and let the conflict guide handle conflicts"],
  '7.3': ['2.35', 'hide', "stash everything first, then restore the unstaged part"],
  '8.12': ['2.30', 'degrade', "force push with lease works from 2.11 to 2.29, but without the extra --force-if-includes protection"],
  '9.4': ['2.17', 'hide', "below 2.17, delete the directory in a terminal, then prune stale entries"],
  '9.5': ['2.31', 'hide', "below 2.31, stale entries cannot be read; run git worktree prune in a terminal"],
  '9.6': ['2.31', 'degrade', "below 2.31, lock markers cannot be read, so they show as unknown; locking still works"],
  '9.7': ['2.17', 'hide', "below 2.17, move the directory in a terminal, then run git worktree repair"],
  '9.8': ['2.25', 'hide', "below 2.25, use git sparse-checkout in a terminal"],
  '11.8': ['2.30', 'hide', "below 2.30, use garbage collection instead of automatic maintenance"],
  '11.9': ['2.18', 'hide', "below 2.18, view the commit graph in a terminal"],
  '11.10': ['2.21', 'hide', "below 2.21, view the multi-pack index in a terminal"],
  '12.6': ['2.36', 'hide', "below 2.36, run the hook file directly in a terminal"],
}

// 规格第 11 节之后的面板替代路径说明：能力号 -> 面板里的替代做法（这几条不推外部工具）。
const PANEL_PATHS: Record<string, string> = {
  '2.7': "write the commit message in the panel multi-line editor; no external editor",
  '5.11': "use the five structured filter-repo forms; filter-branch itself is read-only",
  '6.7': "handle conflicts in the conflict guide multi-line editor; no external editor",
  '6.9': "use the panel conflict view in the conflict guide; mergetool is not called",
  '13.14': "use the graphical view on the commit history page instead of gitk; Manage › Platform and boundaries has one note pointing back to the history page",
}

// 能力矩阵：逐行抄自规格 #1586（162 条，一条不能少）。
const LAYOUT: string = String.raw`
1.1 | View working tree status | git status --porcelain=v2 --branch -z | 读 | 直 | 操作 | 改动页 | 1588 §2-domain 1
1.2 | Stage hunk by hunk | git add -p (the panel equivalent reads the diff, then apply --cached) | 写 | 折 | 操作 | 改动页 | 1588 §2-domain 1
1.3 | Stage one file | git add -- <path> | 写 | 直 | 操作 | 改动页 | 1588 §2-domain 1
1.4 | Stage everything | git add -A | 写 | 直 | 操作 | 改动页 | 1588 §2-domain 1
1.5 | Unstage | git restore --staged -- <path> | 写 | 直 | 操作 | 改动页 | 1588 §2-domain 1
1.6 | Discard unstaged changes in one file | git restore -- <path> | 毁 | 直 | 操作 | 改动页 | 1588 §2-domain 1
1.7 | Discard all unstaged changes | git restore -- . | 毁 | 直 | 操作 | 改动页 | 1588 §2-domain 1
1.8 | Delete untracked files | git clean -fd -- <path> | 毁 | 直 | 操作 | 改动页 | 1588 §2-domain 1
1.9 | Delete tracked files | git rm -- <path> | 写 | 直 | 操作 | 改动页 | 1588 §2-domain 1
1.10 | Stop tracking but keep the file on disk | git rm --cached -- <path> | 写 | 折 | 操作 | 改动页 | 1588 §2-domain 1
1.11 | Rename or move | git mv <old> <new> | 写 | 折 | 操作 | 改动页 | 1588 §2-domain 1
1.12 | Add to the ignore list | gitignore + git check-ignore -v | 写 | 直 | 操作 | 改动页 | 1588 §2-domain 1
1.13 | Find out why this path is ignored | git check-ignore -v | 读 | 诊 | 只读 | 改动页 | 1588 §2-domain 1
2.1 | Commit staged content | git commit -m | 写 | 直 | 操作 | 改动页 | 1588 §2-domain 2
2.2 | Commit all tracked changes | git commit -a -m | 写 | 折 | 操作 | 改动页 | 1588 §2-domain 2
2.3 | Amend the last commit | git commit --amend (can change only the message) | 改写 | 直 | 操作 | 改动页 | 1588 §2-domain 2
2.4 | Create a fixup / squash commit | git commit --fixup / --squash | 写 | 折 | 操作 | 改动页 | 1588 §2-domain 2
2.5 | Skip commit hooks | git commit --no-verify | 写 | 折 | 操作 | 改动页 | 1588 §2-domain 2
2.6 | Sign the commit / add a sign-off line | git commit -S / -s | 写 | 折 | 操作 | 改动页 | 1588 §2-domain 2
2.7 | Write the full message in an editor | git commit (without -m) | 写 | 外 | 操作 | 改动页 | 1588 §2-domain 2; 1593
2.8 | Apply the commit message template | git commit with commit.template | 写 | 折 | 操作 | 改动页 | 1588 §2-domain 2
3.1 | Commit list | git log | 读 | 直 | 操作 | 提交历史页 | 1588 §2-domain 3
3.2 | Single commit details | git show | 读 | 直 | 操作 | 提交历史页 | 1588 §2-domain 3
3.3 | Per-file diff within a commit | git show <oid> -- <path> (add --root for the root commit) | 读 | 折 | 操作 | 提交历史页 | 1588 §2-domain 3
3.4 | Single file history | git log --follow -- <path> | 读 | 折 | 操作 | 提交历史页 | 1588 §2-domain 3
3.5 | Line-level blame | git blame -L | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 3
3.6 | Search commits by message | git log --grep -i | 读 | 折 | 操作 | 提交历史页 | 1588 §2-domain 3
3.7 | Search commits by code change | git log -S / -G | 读 | 折 | 操作 | 提交历史页 | 1588 §2-domain 3
3.8 | Compare two refs | git diff a..b / a...b | 读 | 折 | 操作 | 提交历史页 | 1588 §2-domain 3
3.9 | Compare two commit ranges | git range-diff | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 3
3.10 | Version name | git describe --tags --dirty --always | 读 | 直 | 操作 | 提交历史页 | 1588 §2-domain 3
3.11 | Reflog | git reflog show | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 3
3.12 | Commit notes | git notes show | 读 | 折 | 操作 | 提交历史页 | 1588 §2-domain 3
3.13 | Get a file at a given revision | git show <rev>:<path> | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 3
4.1 | Branch list | git branch -vv / git for-each-ref | 读 | 直 | 操作 | 分支与管理 | 1588 §2-domain 4
4.2 | Create and switch | git switch -c | 写 | 直 | 操作 | 分支与管理 | 1588 §2-domain 4
4.3 | Switch branch | git switch | 写 | 直 | 操作 | 分支与管理 | 1588 §2-domain 4
4.4 | Check out a commit (detached HEAD) | git switch --detach | 写 | 折 | 操作 | 分支与管理 | 1588 §2-domain 4
4.5 | Rename branch | git branch -m | 写 | 直 | 操作 | 分支与管理 | 1588 §2-domain 4
4.6 | Delete branch | git branch -d / -D | 改写 | 直 | 操作 | 分支与管理 | 1588 §2-domain 4
4.7 | Set or unset upstream | git branch -u / --unset-upstream | 写 | 直 | 操作 | 分支与管理 | 1588 §2-domain 4
4.8 | Which branches are merged | git branch --merged / --no-merged | 读 | 诊 | 只读 | 分支与管理 | 1588 §2-domain 4
4.9 | Tag list | git tag -l | 读 | 折 | 操作 | 分支与管理 | 1588 §2-domain 4
4.10 | Create tag | git tag (lightweight) / -a (annotated) / -s (signed) | 写 | 折 | 操作 | 分支与管理 | 1588 §2-domain 4
4.11 | Delete tag | git tag -d | 毁 | 折 | 操作 | 分支与管理 | 1588 §2-domain 4
4.12 | Verify signatures | git verify-commit / git verify-tag | 读 | 诊 | 只读 | 分支与管理 | 1588 §2-domain 4
4.13 | Branch description | git branch --edit-description | 写 | 外 | 操作 | 分支与管理 | 1588 §2-domain 4; 1593
5.1 | Undo the last commit, keeping changes staged | git reset --soft HEAD~1 | 改写 | 直 | 操作 | 变基待办 | 1588 §2-domain 5
5.2 | Undo the commit and unstage | git reset HEAD~1 | 改写 | 折 | 操作 | 变基待办 | 1588 §2-domain 5
5.3 | Hard reset to a commit | git reset --hard | 毁 | 折 | 操作 | 变基待办 | 1588 §2-domain 5
5.4 | Revert a commit | git revert | 写 | 直 | 操作 | 变基待办 | 1588 §2-domain 5
5.5 | Cherry-pick a commit | git cherry-pick | 写 | 直 | 操作 | 变基待办 | 1588 §2-domain 5
5.6 | Interactive rebase (minimum set: reword, squash, drop, reorder) | git rebase -i | 改写 | 折 | 操作 | 变基待办 | 1588 §2-domain 5
5.7 | Rebase onto a new base | git rebase --onto | 改写 | 折 | 操作 | 变基待办 | 1588 §2-domain 5
5.8 | Autosquash fixup / squash | git rebase -i --autosquash | 改写 | 折 | 操作 | 变基待办 | 1588 §2-domain 5
5.9 | Update other branch pointers | git rebase --update-refs | 改写 | 折 | 说明 | 管理·平台与边界 | 1588 §2-domain 5; 1593
5.10 | Keep merge structure | git rebase --rebase-merges | 改写 | 折 | 操作 | 变基待办 | 1588 §2-domain 5
5.11 | Rewrite history in bulk | git filter-branch | 毁 | 外 | 操作 | 管理·维护 | 1588 §2-domain 5; 1593
5.12 | Replace objects | git replace | 改写 | 外 | 操作 | 管理·诊断 | 1588 §2-domain 5; 1593
5.13 | Export / import history | git fast-export / git fast-import | 毁 | 外 | 操作 | 管理·迁移 | 1588 §2-domain 5; 1593
6.1 | Merge branch | git merge | 写 | 直 | 操作 | 冲突向导 | 1588 §2-domain 6
6.2 | Fast-forward only | git merge --ff-only | 写 | 直 | 操作 | 冲突向导 | 1588 §2-domain 6
6.3 | No fast-forward | git merge --no-ff | 写 | 折 | 操作 | 冲突向导 | 1588 §2-domain 6
6.4 | Squash merge | git merge --squash | 写 | 折 | 操作 | 冲突向导 | 1588 §2-domain 6
6.5 | Conflicted file list | git status / git diff --diff-filter=U | 读 | 直 | 操作 | 冲突向导 | 1588 §2-domain 6
6.6 | Take one side for the whole file | git checkout --ours / --theirs | 写 | 折 | 操作 | 冲突向导 | 1588 §2-domain 6
6.7 | Edit conflicts by hand | external editor | 写 | 外 | 操作 | 冲突向导 | 1588 §2-domain 6; 1593
6.8 | Mark resolved | git add -- <path> | 写 | 直 | 操作 | 冲突向导 | 1588 §2-domain 6
6.9 | External merge tool | git mergetool | 写 | 外 | 操作 | 冲突向导 | 1588 §2-domain 6; 1593
6.10 | Preview merge | git merge-tree --write-tree | 读 | 诊 | 只读 | 冲突向导 | 1588 §2-domain 6
6.11 | Continue | --continue (shared by merge / rebase / cherry-pick / revert / am) | 写 | 直 | 操作 | 冲突向导 | 1588 §2-domain 6
6.12 | Skip this step | --skip | 写 | 折 | 操作 | 冲突向导 | 1588 §2-domain 6
6.13 | Abort | --abort | 写 | 直 | 操作 | 冲突向导 | 1588 §2-domain 6
6.14 | Reuse conflict resolutions | git rerere | 读 | 诊 | 只读 | 冲突向导 | 1588 §2-domain 6
6.15 | Check leftover markers before committing | git diff --check | 读 | 诊 | 只读 | 冲突向导 | 1588 §2-domain 6
7.1 | Stash current changes | git stash push -m | 写 | 直 | 操作 | 贮藏页 | 1588 §2-domain 7
7.2 | Stash including untracked files | git stash push -u | 写 | 折 | 操作 | 贮藏页 | 1588 §2-domain 7
7.3 | Stash only staged files | git stash push --staged | 写 | 折 | 操作 | 贮藏页 | 1588 §2-domain 7
7.4 | List | git stash list | 读 | 直 | 操作 | 贮藏页 | 1588 §2-domain 7
7.5 | Show contents | git stash show -p | 读 | 折 | 操作 | 贮藏页 | 1588 §2-domain 7
7.6 | Apply and keep the entry | git stash apply | 写 | 直 | 操作 | 贮藏页 | 1588 §2-domain 7
7.7 | Apply and drop the entry | git stash pop | 写 | 直 | 操作 | 贮藏页 | 1588 §2-domain 7
7.8 | Create a branch from a stash | git stash branch | 写 | 折 | 操作 | 贮藏页 | 1588 §2-domain 7
7.9 | Drop entry | git stash drop | 毁 | 直 | 操作 | 贮藏页 | 1588 §2-domain 7
7.10 | Clear all | git stash clear | 毁 | 折 | 操作 | 贮藏页 | 1588 §2-domain 7
8.1 | Remote list | git remote -v | 读 | 折 | 操作 | 远端与同步 | 1588 §2-domain 8
8.2 | Add / rename / remove remote | git remote add / rename / remove | 写 | 折 | 操作 | 远端与同步 | 1588 §2-domain 8
8.3 | Change URL | git remote set-url | 写 | 折 | 操作 | 远端与同步 | 1588 §2-domain 8
8.4 | View remote branches and tags | git ls-remote / git branch -r | 读 | 折 | 操作 | 远端与同步 | 1588 §2-domain 8
8.5 | Fetch | git fetch [--all] [--prune] [--tags] | 写 | 直 | 操作 | 远端与同步 | 1588 §2-domain 8
8.6 | Pull and merge | git pull | 写 | 直 | 操作 | 远端与同步 | 1588 §2-domain 8
8.7 | Pull and rebase | git pull --rebase | 改写 | 折 | 操作 | 远端与同步 | 1588 §2-domain 8
8.8 | Fast-forward only | git pull --ff-only | 写 | 直 | 操作 | 远端与同步 | 1588 §2-domain 8
8.9 | Push current branch | git push | 写 | 直 | 操作 | 远端与同步 | 1588 §2-domain 8
8.10 | First push and set upstream | git push -u | 写 | 直 | 操作 | 远端与同步 | 1588 §2-domain 8
8.11 | Delete remote branch / tag | git push --delete | 毁 | 折 | 操作 | 远端与同步 | 1588 §2-domain 8
8.12 | Force push (with lease) | git push --force-with-lease | 毁 | 折 | 操作 | 远端与同步 | 1588 §2-domain 8
8.13 | Atomic push | git push --atomic | 写 | 折 | 操作 | 远端与同步 | 1588 §2-domain 8
8.14 | Push tags | git push --follow-tags / --tags | 写 | 折 | 操作 | 远端与同步 | 1588 §2-domain 8
8.15 | Authentication and credentials | git credential / git-credential-cache / git-credential-store | 写 | 外 | 只读 | 管理·平台与边界 | 1588 §2-domain 8; 1593
8.16 | Clone | git clone | 写 | 外 | 操作 | 管理·迁移 | 1588 §2-domain 8; 1593
9.1 | Worktree list | git worktree list | 读 | 直 | 操作 | 工作树页 | 1588 §2-domain 9
9.2 | Create worktree | git worktree add | 写 | 折 | 操作 | 工作树页 | 1588 §2-domain 9
9.3 | Create worktree from an existing branch | git worktree add <path> <branch> | 写 | 折 | 操作 | 工作树页 | 1588 §2-domain 9
9.4 | Remove worktree | git worktree remove | 毁 | 直 | 操作 | 工作树页 | 1588 §2-domain 9
9.5 | Prune stale entries | git worktree prune | 写 | 直 | 操作 | 工作树页 | 1588 §2-domain 9
9.6 | Lock / unlock | git worktree lock / unlock | 写 | 折 | 操作 | 工作树页 | 1588 §2-domain 9
9.7 | Move worktree | git worktree move | 写 | 折 | 操作 | 工作树页 | 1588 §2-domain 9
9.8 | Sparse checkout | git sparse-checkout | 写 | 折 | 操作 | 工作树页 | 1588 §2-domain 9
10.1 | List and status | git submodule status | 读 | 折 | 操作 | 管理·子模组 | 1588 §2-domain 10
10.2 | Add submodule | git submodule add | 写 | 折 | 操作 | 管理·子模组 | 1588 §2-domain 10
10.3 | Initialize and check out | git submodule update --init [--recursive] | 写 | 折 | 操作 | 管理·子模组 | 1588 §2-domain 10
10.4 | Run in every submodule | git submodule foreach | 写 | 外 | 操作 | 管理·子模组 | 1588 §2-domain 10; 1593
10.5 | Change URL / sync | git submodule set-url / sync | 写 | 折 | 操作 | 管理·子模组 | 1588 §2-domain 10
10.6 | Change tracked branch | git submodule set-branch --branch | 写 | 折 | 操作 | 管理·子模组 | 1588 §2-domain 10
10.7 | Deinitialize | git submodule deinit | 毁 | 折 | 操作 | 管理·子模组 | 1588 §2-domain 10
10.8 | Absorb the submodule .git | git submodule absorbgitdirs | 写 | 诊 | 操作 | 管理·子模组 | 1588 §2-domain 10; changed to a controlled write by this decision
11.1 | Initialize repository | git init [--bare] | 写 | 外 | 操作 | 管理·迁移 | 1588 §2-domain 11; 1593
11.2 | Check integrity | git fsck | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 11
11.3 | Find recoverable objects | git fsck --unreachable / --lost-found | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 11
11.4 | Count objects and size | git count-objects -vH | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 11
11.5 | Garbage collection | git gc | 写 | 折 | 操作 | 管理·维护 | 1588 §2-domain 11
11.6 | Prune unreachable objects | git prune | 毁 | 折 | 操作 | 管理·维护 | 1588 §2-domain 11
11.7 | Repack | git repack | 写 | 诊 | 只读 | 管理·维护 | 1588 §2-domain 11
11.8 | Automatic maintenance | git maintenance run / start / stop / register | 写 | 外 | 操作 | 管理·维护 | 1588 §2-domain 11; 1593
11.9 | Commit graph | git commit-graph | 写 | 诊 | 只读 | 管理·维护 | 1588 §2-domain 11
11.10 | Multi-pack index | git multi-pack-index | 写 | 诊 | 只读 | 管理·维护 | 1588 §2-domain 11
11.11 | Pack refs | git pack-refs | 写 | 诊 | 只读 | 管理·维护 | 1588 §2-domain 11
11.12 | Export archive | git archive | 写 | 外 | 操作 | 管理·迁移 | 1588 §2-domain 11; 1593
11.13 | Offline bundle | git bundle create / verify / unbundle | 写 | 外 | 操作 | 管理·迁移 | 1588 §2-domain 11; 1593
11.14 | Migrate ref storage format | git refs migrate | 毁 | 外 | 只读 | 管理·维护 | 1588 §2-domain 11; 1593
11.15 | Large repository tool | scalar | 写 | 外 | 只读 | 管理·维护 | 1588 §2-domain 11; 1593
12.1 | Read config | git config --list --show-origin | 读 | 诊 | 只读 | 管理·配置 | 1588 §2-domain 12
12.2 | Write config | git config set | 写 | 折 | 操作 | 管理·配置 | 1588 §2-domain 12
12.3 | Delete config | git config unset | 写 | 折 | 操作 | 管理·配置 | 1588 §2-domain 12
12.4 | Identity | git config user.name / user.email | 写 | 折 | 操作 | 管理·配置 | 1588 §2-domain 12
12.5 | Hook list | githooks + core.hooksPath | 读 | 诊 | 只读 | 管理·钩子 | 1588 §2-domain 12
12.6 | Run a hook manually | git hook run | 写 | 折 | 操作 | 管理·钩子 | 1588 §2-domain 12
12.7 | Attribute rules | git check-attr / gitattributes | 读 | 诊 | 只读 | 管理·配置 | 1588 §2-domain 12
12.8 | Mailmap | git check-mailmap / gitmailmap | 读 | 诊 | 只读 | 管理·配置 | 1588 §2-domain 12
13.1 | Bisect | git bisect start / bad / good / skip / reset | 写 | 折 | 操作 | 管理·诊断 | 1588 §2-domain 13
13.2 | Bisect visualize / replay | git bisect visualize / replay | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.3 | Search the worktree by content | git grep | 读 | 折 | 操作 | 全库搜索 | 1588 §2-domain 13
13.4 | List files by criteria | git ls-files | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.5 | View object contents | git cat-file -p / -t | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.6 | View tree | git ls-tree | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.7 | Resolve refs and paths | git rev-parse | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.8 | Enumerate refs | git for-each-ref | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.9 | Ancestry check | git merge-base --is-ancestor | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.10 | Patch equivalence | git cherry / git patch-id | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.11 | Counts and left/right difference | git rev-list --count / --left-right | 读 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.12 | Apply patch | git apply --check / --3way | 写 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.13 | Trailers | git interpret-trailers | 写 | 诊 | 只读 | 管理·诊断 | 1588 §2-domain 13
13.14 | Graphical history browser | gitk | 读 | 外 | 操作 | 提交历史页 | 1588 §2-domain 13; 1593
14.1 | Create patch emails | git format-patch | 写 | 外 | 操作 | 管理·迁移 | 1588 §2-domain 14; 1593
14.2 | Send patch emails | git send-email | 写 | 外 | 说明 | 管理·平台与边界 | 1588 §2-domain 14; 1593
14.3 | Pull request summary | git request-pull | 读 | 诊 | 只读 | 管理·平台与边界 | 1588 §2-domain 14
14.4 | PR / Issue / Release |  | 非 git | 外 | 说明 | 管理·平台与边界 | 1588 §2-domain 14; 1593
14.5 | Actions / CI status |  | 非 git | 外 | 说明 | 管理·平台与边界 | 1588 §2-domain 14; 1593
14.6 | Accounts and permissions |  | 非 git | 外 | 说明 | 管理·平台与边界 | 1588 §2-domain 14; 1593
14.7 | Branch protection / no force push |  | 非 git | 外 | 说明 | 管理·平台与边界 | 1588 §2-domain 14; 1593
14.8 | Repository transfer / archive |  | 非 git | 外 | 说明 | 管理·平台与边界 | 1588 §2-domain 14; 1593
`

interface LedgerRow {
  id: string
  name: string
  command: string
  level: string
  placement: string
  finalForm: string
  primaryEntry: string
  basis: string
}

interface Capability {
  id: string
  domain: number
  domainName: string
  name: string
  command: string
  level: string
  placement: string
  finalForm: string
  primaryEntry: string
  page: string
  panelPath: string | null
  minVersion: string
  versionPolicy: string | null
  versionAlternative: string | null
  researchBasis: string
}

const LEVELS: string[] = ['读', '写', '毁', '改写', '非 git']
const PLACEMENTS: string[] = ['直', '折', '诊', '外']
const FINAL_FORMS: string[] = ['操作', '只读', '说明']
const FLOOR: string = '2.11'
const EXPECTED_LEVEL: Record<string, number> = { '读': 48, '写': 83, '毁': 15, '改写': 11, '非 git': 5 }
const EXPECTED_PLACEMENT: Record<string, number> = { '直': 42, '折': 62, '诊': 34, '外': 24 }
const EXPECTED_FINAL_FORM: Record<string, number> = { '操作': 119, '只读': 36, '说明': 7 }

const PAGE_BY_ENTRY: Record<string, string> = {}
for (const page of PAGES) PAGE_BY_ENTRY[page[3]] = page[0]

function parseLayout(text: string): LedgerRow[] {
  const rows: LedgerRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const cells = line.split(' | ')
    if (cells.length !== 8) throw new Error('LAYOUT 行字段数不是 8：' + line)
    rows.push({ id: cells[0], name: cells[1], command: cells[2], level: cells[3], placement: cells[4], finalForm: cells[5], primaryEntry: cells[6], basis: cells[7] })
  }
  return rows
}

function countBy(list: Capability[], pick: (cap: Capability) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const cap of list) {
    const key = pick(cap)
    out[key] = (out[key] || 0) + 1
  }
  return out
}

function sameCounts(got: Record<string, number>, expected: Record<string, number>): boolean {
  const names = Object.keys(expected)
  if (Object.keys(got).length !== names.length) return false
  for (const name of names) if (got[name] !== expected[name]) return false
  return true
}

function buildCapabilities(rows: LedgerRow[]): Capability[] {
  return rows.map((row) => {
    const domain = Number(row.id.split('.')[0])
    const page = PAGE_BY_ENTRY[row.primaryEntry]
    if (!page) throw new Error('主入口没有登记页面：' + row.primaryEntry)
    const note = VERSION_NOTES[row.id]
    return {
      id: row.id,
      domain,
      domainName: DOMAINS[domain],
      name: row.name,
      command: row.command,
      level: row.level,
      placement: row.placement,
      finalForm: row.finalForm,
      primaryEntry: row.primaryEntry,
      page,
      panelPath: PANEL_PATHS[row.id] || null,
      minVersion: note ? note[0] : FLOOR,
      versionPolicy: note ? note[1] : null,
      versionAlternative: note ? note[2] : null,
      researchBasis: row.basis,
    }
  })
}

function validate(rows: LedgerRow[], caps: Capability[]): void {
  if (rows.length !== 162) throw new Error('能力矩阵不是 162 条：' + rows.length)
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('能力号有重复')
  if (caps.length !== 162) throw new Error('能力表不是 162 条：' + caps.length)
  for (const row of rows) {
    const idParts = row.id.split('.')
    if (idParts.length !== 2 || idParts[1] === '0' || String(Number(idParts[1])) !== idParts[1]) throw new Error('能力号形状不对：' + row.id)
    if (!DOMAINS[Number(idParts[0])]) throw new Error('能力号指向没登记的域：' + row.id)
    if (LEVELS.indexOf(row.level) < 0) throw new Error('级别不在允许值里：' + row.id)
    if (PLACEMENTS.indexOf(row.placement) < 0) throw new Error('落点不在允许值里：' + row.id)
    if (FINAL_FORMS.indexOf(row.finalForm) < 0) throw new Error('终局不在允许值里：' + row.id)
  }
  if (!sameCounts(countBy(caps, (cap) => cap.level), EXPECTED_LEVEL)) throw new Error('级别分布与规格数不一致')
  if (!sameCounts(countBy(caps, (cap) => cap.placement), EXPECTED_PLACEMENT)) throw new Error('落点分布与规格数不一致')
  if (!sameCounts(countBy(caps, (cap) => cap.finalForm), EXPECTED_FINAL_FORM)) throw new Error('终局计数与规格数不一致')
}

function capabilityBlock(cap: Capability): string {
  return [
    '  {',
    '    id: ' + JSON.stringify(cap.id) + ',',
    '    domain: ' + String(cap.domain) + ',',
    '    domainName: ' + JSON.stringify(cap.domainName) + ',',
    '    name: ' + JSON.stringify(cap.name) + ',',
    '    command: ' + JSON.stringify(cap.command) + ',',
    '    level: ' + JSON.stringify(cap.level) + ',',
    '    placement: ' + JSON.stringify(cap.placement) + ',',
    '    finalForm: ' + JSON.stringify(cap.finalForm) + ',',
    '    primaryEntry: ' + JSON.stringify(cap.primaryEntry) + ',',
    '    page: ' + JSON.stringify(cap.page) + ',',
    '    panelPath: ' + (cap.panelPath === null ? 'null' : JSON.stringify(cap.panelPath)) + ',',
    '    minVersion: ' + JSON.stringify(cap.minVersion) + ',',
    '    versionPolicy: ' + (cap.versionPolicy === null ? 'null' : JSON.stringify(cap.versionPolicy)) + ',',
    '    versionAlternative: ' + (cap.versionAlternative === null ? 'null' : JSON.stringify(cap.versionAlternative)) + ',',
    '    researchBasis: ' + JSON.stringify(cap.researchBasis) + ',',
    '  },',
  ].join('\n')
}

export function renderLedger(): string {
  const rows = parseLayout(LAYOUT)
  const caps = buildCapabilities(rows)
  validate(rows, caps)
  const lines: string[] = []
  lines.push('// AUTO-GENERATED。来源脚本：scripts/generate-1586-capability-ledger.mts（数据来自规格 #1586 第 11 节 162 条能力矩阵、第 6 节版本条款与 #1590 原型数据）。')
  lines.push('// 不要手改本文件：要改账本先改生成器里的数据表，再重跑生成器；门禁 tests/verify-1586-capability-ledger.ts 会 --check 对账。')
  lines.push('//');
  lines.push('// 这是版本管理页的能力账本，全规格只有这一份数据源：界面渲染、命令面板、覆盖验收与测试都从这里读，');
  lines.push('// 谁在别处再抄一份 id、名称、命令原文或统计数字，门禁会判红。');
  lines.push('//');
  lines.push('// 字段口径（逐条对齐规格 #1586 第 11 节矩阵与第 6 节版本条款）：');
  lines.push('//   id：规格矩阵的能力号（域号.序号），改动记录与票据引用的就是它；');
  lines.push('//   level：读 / 写 / 毁 / 改写 / 非 git，按这个动作对仓库的破坏力分；');
  lines.push('//   placement：直（直接执行）/ 折（收进折叠菜单）/ 诊（诊断读用）/ 外（面板不做，只给说明或替代路径）；');
  lines.push('//   finalForm：操作（面板真能做）/ 只读（面板只显示）/ 说明（面板只解释，命令列为空）；');
  lines.push('//   page：能力落在哪个页面，见 PAGE_SURFACES，命令面板据此带「去这里」；');
  lines.push('//   panelPath：面板替代路径，非空表示这条能力不推外部工具、面板里有对应做法；');
  lines.push('//   minVersion：这条能力要求的最低 git 版本，低于它按 versionPolicy 降级或隐藏；');
  lines.push('//   versionPolicy：degrade（低版本给替代做法）/ hide（低版本藏起来）/ null（2.11 底线内都能用）；');
  lines.push('//   researchBasis：研究依据（1588 第 2 章哪一域，1593 是补充结论）。');
  lines.push('');
  lines.push('export type CapabilityLevel = "读" | "写" | "毁" | "改写" | "非 git"')
  lines.push('export type CapabilityPlacement = "直" | "折" | "诊" | "外"')
  lines.push('export type CapabilityFinalForm = "操作" | "只读" | "说明"')
  lines.push('export type CapabilityVersionPolicy = "degrade" | "hide"')
  lines.push('export type CapabilityPageKind = "页签" | "管理分区" | "二级页" | "全局面"')
  lines.push('export type CapabilityPageId = "changes" | "commits" | "worktrees" | "stash" | "branch-tags" | "remote" | "submodules" | "maintenance" | "migrate" | "config" | "hooks" | "diagnostics" | "platform" | "rebase" | "conflicts" | "search"')
  lines.push('export type PrimaryEntry = "改动页" | "提交历史页" | "工作树页" | "贮藏页" | "分支与管理" | "远端与同步" | "管理·子模组" | "管理·维护" | "管理·迁移" | "管理·配置" | "管理·钩子" | "管理·诊断" | "管理·平台与边界" | "变基待办" | "冲突向导" | "全库搜索"')
  lines.push('');
  lines.push('export interface CapabilityPage {')
  lines.push('  id: CapabilityPageId')
  lines.push('  name: string')
  lines.push('  kind: CapabilityPageKind')
  lines.push('  primaryEntry: PrimaryEntry')
  lines.push('}')
  lines.push('');
  lines.push('export interface Capability {')
  lines.push('  id: string')
  lines.push('  domain: number')
  lines.push('  domainName: string')
  lines.push('  name: string')
  lines.push('  command: string')
  lines.push('  level: CapabilityLevel')
  lines.push('  placement: CapabilityPlacement')
  lines.push('  finalForm: CapabilityFinalForm')
  lines.push('  primaryEntry: PrimaryEntry')
  lines.push('  page: CapabilityPageId')
  lines.push('  panelPath: string | null')
  lines.push('  minVersion: string')
  lines.push('  versionPolicy: CapabilityVersionPolicy | null')
  lines.push('  versionAlternative: string | null')
  lines.push('  researchBasis: string')
  lines.push('}')
  lines.push('');
  lines.push('export const CAPABILITY_TOTAL = 162')
  lines.push('');
  lines.push('export const DOMAIN_NAMES: Record<number, string> = {')
  for (const key of Object.keys(DOMAINS)) lines.push('  ' + key + ': ' + JSON.stringify(DOMAINS[Number(key)]) + ',')
  lines.push('}')
  lines.push('');
  lines.push('export const PAGE_SURFACES: CapabilityPage[] = [')
  for (const page of PAGES) lines.push('  { id: ' + JSON.stringify(page[0]) + ', name: ' + JSON.stringify(page[1]) + ', kind: ' + JSON.stringify(page[2]) + ', primaryEntry: ' + JSON.stringify(page[3]) + ' },')
  lines.push(']')
  lines.push('');
  lines.push('export const PRIMARY_ENTRY_PAGE: Record<PrimaryEntry, CapabilityPageId> = {')
  for (const page of PAGES) lines.push('  ' + JSON.stringify(page[3]) + ': ' + JSON.stringify(page[0]) + ',')
  lines.push('}')
  lines.push('');
  const levelCounts = countBy(caps, (cap) => cap.level)
  const placementCounts = countBy(caps, (cap) => cap.placement)
  const finalFormCounts = countBy(caps, (cap) => cap.finalForm)
  const pageCounts = countBy(caps, (cap) => cap.page)
  lines.push('export const LEVEL_COUNTS: Record<CapabilityLevel, number> = {')
  for (const level of LEVELS) lines.push('  ' + JSON.stringify(level) + ': ' + String(levelCounts[level] || 0) + ',')
  lines.push('}')
  lines.push('');
  lines.push('export const PLACEMENT_COUNTS: Record<CapabilityPlacement, number> = {')
  for (const placement of PLACEMENTS) lines.push('  ' + JSON.stringify(placement) + ': ' + String(placementCounts[placement] || 0) + ',')
  lines.push('}')
  lines.push('');
  lines.push('export const FINAL_FORM_COUNTS: Record<CapabilityFinalForm, number> = {')
  for (const form of FINAL_FORMS) lines.push('  ' + JSON.stringify(form) + ': ' + String(finalFormCounts[form] || 0) + ',')
  lines.push('}')
  lines.push('');
  lines.push('export const PAGE_COUNTS: Record<CapabilityPageId, number> = {')
  for (const page of PAGES) lines.push('  ' + JSON.stringify(page[0]) + ': ' + String(pageCounts[page[0]] || 0) + ',')
  lines.push('}')
  lines.push('');
  const gated = caps.filter((cap) => cap.minVersion !== FLOOR).map((cap) => cap.id)
  lines.push('export const VERSION_GATED_IDS: string[] = [' + gated.map((id) => JSON.stringify(id)).join(', ') + ']')
  lines.push('');
  lines.push('// 162 条能力：界面、命令面板与验收都从这份数组读，别处不再抄一份。')
  lines.push('export const CAPABILITIES: Capability[] = [')
  for (const cap of caps) lines.push(capabilityBlock(cap))
  lines.push(']')
  lines.push('');
  lines.push('export const CAPABILITY_LEDGER_SOURCE = "src/shared/version-control/src/capability-ledger.ts"')
  return lines.join('\n') + '\n'
}

function main(): void {
  const checkOnly = process.argv.slice(2).indexOf('--check') >= 0
  const text = renderLedger()
  if (checkOnly) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error('FAIL 账本还没生成：请先跑 node ' + GENERATOR_REL)
      process.exit(1)
    }
    const current = fs.readFileSync(OUT_PATH, 'utf8')
    if (current !== text) {
      console.error('FAIL 生成源码与生成器数据表对不上：请先跑生成器，命令 node ' + GENERATOR_REL)
      process.exit(1)
    }
    console.log('OK 账本与生成器数据表一致（' + GENERATOR_REL + '）')
    return
  }
  fs.writeFileSync(OUT_PATH, text)
  console.log('已写出 ' + LEDGER_REL)
}

const entry = process.argv[1] ? url.pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) main()

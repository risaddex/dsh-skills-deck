// tests/lib/deck-backend-matrix.ts —— #73 两扇后端矩阵门禁共用的夹具：四个后端各自「真实房间 + 真实开会话管线」的假身。
//
// 为什么单独一份：树读与票读要按同一张后端清单各证明一次，用的必须是同一套假身 —— 两条读各写一份夹具，
// 就会出现「树读那份的 GitHub 回包与票读那份悄悄不一样」，而两扇门禁照样绿。夹具本身就是判据的一部分。
//
// 假的是**运输层**（gh / glab 的起进程出口、Linear 的 HTTP 通道、本地 Markdown 的临时工作区），
// 真的是一切上层：房间模块自己解析回包、wrapTracker 补齐形状、createSessionOpener 开会话、宿主电话投影。
// 所以这里的每一段都是「真实后端路径 + 脚本化的对端回话」，不是另一条手写数据路径。
//
// 边界：只造数据与出口，不断言；断言与计数留在各自的门禁文件里。每个 backend 的 story 参数就是
// 「对端这一次回了什么」，门禁按票面各给一份。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { wrapTracker } from '../../src/tracker/registry/shape.ts'
import { createSessionOpener } from '../../src/refresh/rooms/host/session-opener.ts'
import { createOutboundControl } from '../../src/refresh/rooms/host/outbound-control.ts'
import { githubModule } from '../../src/tracker/rooms/github/room/index.ts'
import { gitlabBackend } from '../../src/tracker/rooms/gitlab/index.ts'
import { markdownModule } from '../../src/tracker/rooms/markdown/index.ts'
import { linearModule, createLinearBackend } from '../../src/tracker/rooms/linear/index.ts'
import type { LinearAccount } from '../../src/tracker/rooms/linear/client.ts'

/** 四个后端的仓库身份：形状就是真实 openSession 交给 Tracker 契约的那一份。 */
export const REPOS: Record<string, any> = {
  github: { backend: 'github', refId: 'acme/demo', name: 'demo', url: 'https://example.test/acme/demo' },
  gitlab: { backend: 'gitlab', refId: 'group/project', name: 'project', url: 'https://example.test/group/project' },
  markdown: { backend: 'markdown', refId: '.scratch/demo', name: 'demo', url: '' },
  linear: { backend: 'linear', refId: 'ENG', name: 'ENG', url: '' },
}

/** 一个后端的假会话：openSession 就是门禁要交给宿主电话的那一个出口，calls 记下每一次开/读。 */
export type DeckSession = {
  openSession: (cwd: string, opts?: { write?: boolean }) => Promise<any>
  calls: any[]
  cwd: string
}

/** 假会话解析：任何 sessionId 都解析到这一个工作区（真实解析器另有门禁证明）。 */
export function cwdReply(cwd: string): (args: { sessionId: string }) => Promise<any> {
  return async (args: { sessionId: string }) => ({ ok: true, cwd, workspaceRoot: cwd, sessionId: args.sessionId })
}

/** 假注册表 + 真实开会话管线：把房间实例包成契约的 Tracker，再来。
 *  顺序与真实装配一致：wrapTracker（补缺方法的桩）→ registry（选择 + 取实例 + 模块预算）→ createSessionOpener。 */
function sessionOf(backendId: string, mod: any, tracker: any, ctx: any, cwd: string): DeckSession {
  const calls: any[] = []
  const session = {
    list: async (ref: any, filter: any, opCtx: any) => {
      calls.push({ kind: 'list', ref, filter })
      return tracker.list(ref, filter, opCtx)
    },
    get: async (ref: any, key: any, opt: any, opCtx: any) => {
      calls.push({ kind: 'get', ref, key, opt })
      return tracker.get(ref, key, opt, opCtx)
    },
  }
  const registry = {
    select: async () => ({ backendId, source: 'explicit', ref: REPOS[backendId] }),
    get: () => session,
    modules: () => [mod],
  }
  const opener = createSessionOpener({ getTrackerRegistry: async () => registry, ledger: null, backendCtx: () => ctx })
  return {
    cwd,
    calls,
    openSession: async (cwdArg: string, opts: { write?: boolean }) => {
      calls.push({ kind: 'open', cwd: cwdArg, opts })
      return opener(cwdArg, opts)
    },
  }
}

// ── GitHub：脚本化的 gh。回包形状按真实 GraphQL 查询回（issues / pullRequests 两条连接）──

/** 一张 GitHub 工单节点（GraphQL 形状）：只有查询真正会选的字段。 */
export function githubNode(number: number, extra: any = {}): any {
  return {
    number,
    title: 'Ticket ' + number,
    state: 'OPEN',
    body: '',
    url: 'https://example.test/acme/demo/issues/' + number,
    labels: { nodes: [] },
    parent: null,
    blockedBy: { nodes: [] },
    ...extra,
  }
}

/** 一张 GitHub 探索地图节点：靠 `wayfinder:map` 标签被认成容器（写侧也是这么标的）。 */
export function githubMap(number: number, extra: any = {}): any {
  return githubNode(number, {
    title: 'Exploration map ' + number,
    labels: { nodes: [{ name: 'wayfinder:map', color: '10b981' }] },
    ...extra,
  })
}

export type GithubStory = { issues: any[]; pulls?: any[]; issue?: any }

/** 一个脚本化的 gh：按查询文本判是工单列表、拉取请求列表、单票还是单票 PR，回对应回包。 */
export function githubSession(story: GithubStory): DeckSession {
  const exec = async (_cmd: string, args: string[]) => {
    const joined = (args || []).join(' ')
    const reply = (payload: unknown) => ({ code: 0, stdout: JSON.stringify(payload), stderr: '' })
    if (joined.includes('issues(first:')) {
      return reply({ data: { repository: { issues: { nodes: story.issues, pageInfo: { hasNextPage: false, endCursor: null } } } } })
    }
    if (joined.includes('pullRequests(first:')) {
      return reply({ data: { repository: { pullRequests: { nodes: story.pulls || [], pageInfo: { hasNextPage: false, endCursor: null } } } } })
    }
    // 同一号先查工单、查不着才查拉取请求：票读那条路会走这两步，这里如实回「不是 PR」。
    if (joined.includes('pullRequest(number:')) return reply({ data: { repository: { pullRequest: null } } })
    if (joined.includes('issue(number:')) return reply({ data: { repository: { issue: story.issue || null } } })
    // REST 兜底与其他端点：空数组足够（这一扇不判降级路）。
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const ctx: any = {
    cwd: '/ws/github',
    outbound: createOutboundControl(),
    platform: { resolveExecutable: async (name: string) => (name === 'gh' ? 'gh' : null) },
    exec,
    fs: null,
    isEnabled: () => false,
    logEvent: () => {},
  }
  const tracker = wrapTracker(githubModule as any, (githubModule as any).create(ctx), ctx)
  return sessionOf('github', githubModule, tracker, ctx, '/ws/github')
}

// ── GitLab：脚本化的 glab。列表回一页行；单票回一张票，评论与链接各回空数组 ──

/** 一张 GitLab 工单行（REST 形状）。 */
export function gitlabRow(iid: number, extra: any = {}): any {
  return { iid, title: 'Ticket ' + iid, state: 'opened', description: '', web_url: 'https://example.test/group/project/-/issues/' + iid, ...extra }
}

/** 一张 GitLab 探索地图行：靠 `wayfinder:map` 标签被认成容器。 */
export function gitlabMap(iid: number, extra: any = {}): any {
  return gitlabRow(iid, { title: 'Exploration map ' + iid, labels: [{ name: 'wayfinder:map', color: '#4EA7FC' }], ...extra })
}

export type GitlabStory = { rows: any[]; issue?: any }

export function gitlabSession(story: GitlabStory): DeckSession {
  const exec = async (_cmd: string, args: string[]) => {
    const url = (args || []).join(' ')
    const reply = (payload: unknown) => ({ code: 0, stdout: JSON.stringify(payload), stderr: '' })
    if (/\/notes(\?|$)/.test(url)) return reply([])
    if (/\/links(\?|$)/.test(url)) return reply([])
    // 单票：URL 里带 `/issues/<iid>`；列表是 `/issues?state=...`，两者靠「有没有编号」分开。
    if (/\/issues\/[^?\s]+/.test(url)) return reply(story.issue || null)
    return reply(story.rows)
  }
  const ctx: any = {
    cwd: '/ws/gitlab',
    platform: { resolveExecutable: async () => '/usr/bin/glab' },
    fs: null,
    exec,
    isEnabled: () => false,
    logEvent: () => {},
    gate: null,
    timers: {},
  }
  const tracker = wrapTracker(gitlabBackend as any, (gitlabBackend as any).create(ctx), ctx)
  return sessionOf('gitlab', gitlabBackend, tracker, ctx, '/ws/gitlab')
}

// ── Linear：假 HTTP 通道（Relay 形状的 GraphQL），房间照常解析 ──

const LINEAR_ACCOUNT: LinearAccount = { alias: 'demo', endpoint: 'https://api.linear.app/graphql', authorization: 'lin_api_test' }

/** 一张 Linear 工单节点（Relay 节点形状）。 */
export function linearNode(identifier: string, extra: any = {}): any {
  return {
    id: 'uuid-' + identifier,
    identifier,
    number: Number(String(identifier).replace(/^\D+/, '')) || 1,
    title: 'Ticket ' + identifier,
    description: '',
    url: 'https://linear.app/x/issue/' + identifier,
    createdAt: '2026-11-18T10:00:00Z',
    updatedAt: '2026-11-18T11:00:00Z',
    state: { name: 'Todo', type: 'unstarted' },
    team: { key: 'ENG', name: 'Engineering' },
    parent: null,
    assignee: null,
    labels: { nodes: [] },
    ...extra,
  }
}

/** 一张 Linear 探索地图节点：靠 `wayfinder:map` 标签被认成容器。 */
export function linearMap(identifier: string, extra: any = {}): any {
  return linearNode(identifier, {
    title: 'Exploration map ' + identifier,
    parent: null,
    labels: { nodes: [{ name: 'wayfinder:map', color: '#4EA7FC' }] },
    ...extra,
  })
}

export type LinearStory = { issues: any[]; issue?: any }

export function linearSession(story: LinearStory): DeckSession {
  const ctx: any = {
    opId: 'op-linear-73',
    isEnabled: () => false,
    logEvent: () => {},
    http: {
      request: async (req: any) => {
        const body = JSON.parse(req.body)
        const vars = body.variables || {}
        const reply = (payload: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(payload) })
        // 单票那条查询带 id（标识符），列表那条带 first + filter。
        if (typeof vars.id === 'string') return reply({ data: { issue: story.issue || null } })
        return reply({ data: { issues: { nodes: story.issues, pageInfo: { hasNextPage: false, endCursor: null } } } })
      },
    },
  }
  const tracker = wrapTracker(linearModule as any, createLinearBackend(ctx, LINEAR_ACCOUNT) as any, ctx)
  return sessionOf('linear', linearModule, tracker, ctx, '/ws/linear')
}

// ── 本地 Markdown：真盘上的临时工作区 + 只读文件适配器（与既有 Markdown 门禁同一套形状）──

/**
 * 在临时目录里写一个「一个地图 + 两张票」的工作区：
 *  · map.md 是这个工作单元的容器；issues/ 下的票文件按目录规则挂到它下面（parentKey='00'）；
 *  · 01 号给了一次阻塞引用（Blocked by: 02），02 号就是那个阻塞者；
 *  · 01 号的正文带有验收标准与进度，票读要读得出来。
 */
export function markdownWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-73-md-'))
  const dir = path.join(root, '.scratch', 'demo')
  fs.mkdirSync(path.join(dir, 'issues'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'map.md'), ['# Exploration map MD', '', 'Status: ready-for-agent', '', '## Destination', '', '夹具里的地图'].join('\n'), 'utf8')
  fs.writeFileSync(path.join(dir, 'issues', '02-blocker.md'), ['# Blocker ticket', '', 'Status: ready-for-agent', '', '## Body', '', '挡住 01 的那张票'].join('\n'), 'utf8')
  fs.writeFileSync(path.join(dir, 'issues', '01-open.md'), [
    '# Open ticket from markdown',
    '',
    'Status: ready-for-agent',
    '',
    'Labels: wayfinder:task',
    '',
    'Blocked by: 02',
    '',
    '## Body',
    '',
    'A ticket the phone panel should show.',
    '',
    '本地 Markdown 的一张票。',
    '',
    '## Acceptance criteria',
    '',
    '- [x] The read resolves the workspace from the session',
    '- [ ] Comments stay out of the response',
    '',
    '## Progress',
    '',
    '- Progress: 40% (2026-11-23T15:15:33-03:00): Half of it is done',
  ].join('\n'), 'utf8')
  return root
}

export function markdownSession(root?: string): DeckSession {
  const cwd = root || markdownWorkspace()
  const fsAdapter = {
    async resolve(p: string) { return p },
    async readText(target: string) { return fs.readFileSync(target, 'utf8') },
    async writeText(target: string, text: string) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text, 'utf8') },
    async lstat(target: string) { try { return fs.statSync(target) } catch { return null } },
    async listDir(target: string) { try { return fs.readdirSync(target) } catch { return [] } },
    async stat(target: string) { try { return fs.statSync(target) } catch { return null } },
  }
  const ctx: any = {
    platform: { path: path.posix, fs: fsAdapter },
    fs: fsAdapter,
    cwd,
    opId: 'op-md-73',
    isEnabled: () => false,
    logEvent: () => {},
  }
  const tracker = wrapTracker(markdownModule as any, (markdownModule as any).create(ctx), ctx)
  return sessionOf('markdown', markdownModule, tracker, ctx, cwd)
}

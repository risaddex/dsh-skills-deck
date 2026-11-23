// tests/lib/deck-ticket-fixture.ts —— #72 三扇门禁共用的夹具：一个假的仓库身份、一个假会话解析器、
// 一个假只读会话，以及一张「什么都有」的票与它的正文。
//
// 为什么单独一份：票读的门禁按行为分组拆成三份（投影 / 失败 / 真实接缝），三份都要用同一张票、
// 同一个仓库身份与同一条「会话 → 只读会话」的假路。各写一份夹具，就会出现「投影那份的票与失败那份的票
// 悄悄不一样」，而门禁照样绿 —— 夹具本身就是判据的一部分。
//
// 边界：这里只造数据与假出口，不断言任何东西；断言与计数留在各自的门禁文件里。

/** 假仓库身份：与真实 openSession 交给 Tracker 契约的 repoRef 同一个形状。 */
export const REPO = { backend: 'github', refId: 'acme/demo', name: 'acme/demo', url: 'https://example.test/acme/demo' }

/** 假会话解析：任何 sessionId 都解析到同一个工作区（要有「找不到」的分支时，门禁自己另写一个）。 */
export const okCwd = async (args: any) => ({ ok: true, cwd: '/workspace/demo', workspaceRoot: '/workspace/demo', sessionId: args.sessionId })

/** 一张「七样东西都有」的票的正文：验收标准（勾选与未勾选都有）、进度区、别的区。 */
export const FULL_BODY = [
  '## What to build',
  '',
  'Something the panel should show.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] The read resolves the workspace from the session',
  '- [x] The detail returns the labels',
  '- [ ] Comments stay out of the response',
  '',
  '## Progress',
  '',
  '- Progress: 40% (2026-11-23T15:15:33-03:00): Half of it is done',
  '',
  '## Out of scope',
  '',
  '- Comment threads',
].join('\n')

/** 那一张票本身：键、数字号、状态、标签（一有颜色一无颜色）、阻塞者、评论。 */
export const FULL_TICKET = {
  key: '72',
  number: 72,
  type: 'issue',
  title: 'Read one deck ticket for the same session',
  state: 'open',
  body: FULL_BODY,
  url: 'https://example.test/acme/demo/issues/72',
  createdAt: '2026-11-23T17:00:00Z',
  updatedAt: '2026-11-23T17:57:08Z',
  closedAt: null,
  parentKey: '70',
  labels: [{ name: 'ready-for-agent', color: '0e8a16' }, { name: 'bug', color: '' }],
  blockedBy: [{ key: '71', title: 'Read the session deck tree', state: 'closed' }],
  comments: [{ id: 'c1', author: { login: 'someone' }, body: 'SECRET COMMENT TEXT', createdAt: '2026-11-23T17:10:00Z', updatedAt: '2026-11-23T17:10:00Z' }],
  commentCount: 3,
}

/** 假只读会话：把每一次 open 与 get 的入参记进 calls，回包里放的票由调用方给。 */
export function openedWithTicket(issue: unknown, calls: any[], resultExtra: any = {}) {
  return async (cwd: string, opts: any) => {
    calls.push({ kind: 'open', cwd, opts })
    return {
      ok: true,
      backendId: 'github',
      repoRef: REPO,
      call: async (fn: any) => fn({
        get: async (ref: any, key: any, opt: any, ctx: any) => {
          calls.push({ kind: 'get', ref, key, opt, ctx })
          return Object.assign({ ok: true, data: issue }, resultExtra)
        },
      }, { cwd }),
    }
  }
}

// verify-10-bilingual-ticket-text.ts — #10 regression gate: ticket text is read in Chinese and English, written in English.
// Usage: node --import ./scripts/ts-hook.mts tests/verify-10-bilingual-ticket-text.ts (runs on its own).
//
// Why this gate exists: dsh-skills-deck became English first. The writers of the progress section, the
// maintainer's-words section and the pending-labels section now write English, while tickets that already
// live on GitHub, GitLab and in .scratch/ carry the Chinese headings. The fixtures under
// tests/fixtures/10-bilingual-ticket-text/ hold one Chinese and one English ticket per backend; every check
// below reads both through the real normalizer of that backend and the shared readers, then writes into both
// and asserts that the new text is English and that nothing already written is lost.
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const ROOT: string = path.resolve(__dirname, '..')
const FIX = path.join(ROOT, 'tests', 'fixtures', '10-bilingual-ticket-text')
let failed = false
let total = 0
const check = (ok: boolean, msg: string): void => { total += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failed = true }
const imp = (rel: string): Promise<any> => import(pathToFileURL(path.join(ROOT, rel)).href)
const fixture = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8')

async function main() {
  console.log('#10 ticket text: read Chinese and English, write English only')
  const progress = await imp('src/shared/issue-file/src/progress.ts')
  const words = await imp('src/shared/issue-file/src/original-words.ts')
  const github = await imp('src/tracker/rooms/github/model/normalize.ts')
  const gitlab = await imp('src/tracker/rooms/gitlab/model/normalize.ts')
  const markdown = await imp('src/tracker/rooms/markdown/normalize.ts')
  const commentFormat = await imp('src/tracker/rooms/markdown/comment-format.ts')
  const patchBody = await imp('src/tracker/rooms/markdown/patch-body.ts')
  const minimalSpec = await imp('src/deck/rules/minimal-spec.ts')

  // Each backend hands the body over in its own field; read it back through the real normalizer.
  const bodies: Record<string, string> = {
    'github-zh': github.normalizeIssue({ number: 101, title: 'zh', state: 'OPEN', body: fixture('github-zh.md') }).body,
    'github-en': github.normalizeIssue({ number: 102, title: 'en', state: 'OPEN', body: fixture('github-en.md') }).body,
    'gitlab-zh': gitlab.normalizeIssue({ iid: 201, title: 'zh', state: 'opened', description: fixture('gitlab-zh.md') }).body,
    'gitlab-en': gitlab.normalizeIssue({ iid: 202, title: 'en', state: 'opened', description: fixture('gitlab-en.md') }).body,
    'scratch-zh': markdown.normalizeIssue(fixture('scratch-zh.md'), { key: '01', url: '.scratch/i10/issues/01-zh.md' }).body,
    'scratch-en': markdown.normalizeIssue(fixture('scratch-en.md'), { key: '02', url: '.scratch/i10/issues/02-en.md' }).body,
  }
  Object.keys(bodies).forEach((k) => check(typeof bodies[k] === 'string' && bodies[k].length > 0, k + ': the backend normalizer hands back the body'))

  // —— 1. Readers accept both languages ——
  const expectProgress: Record<string, number> = { 'github-zh': 40, 'github-en': 40, 'gitlab-zh': 30, 'gitlab-en': 30, 'scratch-zh': 70, 'scratch-en': 70 }
  Object.keys(expectProgress).forEach((k) => {
    const got = progress.parseProgressDetail(bodies[k])
    check(got.percent === expectProgress[k], k + ': progress reads ' + expectProgress[k] + ' (got ' + JSON.stringify(got.percent) + ')')
  })
  const ghZh = progress.parseProgressDetail(bodies['github-zh'])
  const ghEn = progress.parseProgressDetail(bodies['github-en'])
  check(ghZh.entries.length === 2 && ghZh.entries[1].updatedAt === null && ghZh.entries[1].note === '老记录', 'github-zh: the Chinese "time not recorded" entry reads with updatedAt null')
  check(ghEn.entries.length === 2 && ghEn.entries[1].updatedAt === null && ghEn.entries[1].note === 'old entry', 'github-en: the English "time not recorded" entry reads with updatedAt null')
  check(ghEn.entries[0].updatedAt === '2026-11-14T08:30:00-03:00' && ghEn.entries[0].note === 'reader done', 'github-en: time and note of an English entry read exactly')

  const expectWords: Record<string, { text: string; source: string; recordedAt: string | null }> = {
    'github-zh': { text: '第一行原话\n\n第三行原话', source: 'https://github.com/risaddex/dsh-skills-deck/issues/10', recordedAt: null },
    'github-en': { text: 'first line of the words\n\nthird line of the words', source: 'https://github.com/risaddex/dsh-skills-deck/issues/10', recordedAt: null },
    'gitlab-zh': { text: 'GitLab 里的原话', source: '本会话（2026-10-21T22:05+08:00）', recordedAt: '2026-10-21T22:05+08:00' },
    'gitlab-en': { text: 'words kept in GitLab', source: 'this session (2026-11-14T08:31-03:00)', recordedAt: '2026-11-14T08:31-03:00' },
    'scratch-zh': { text: '本地原话', source: '本会话（2026-10-21T22:05+08:00）', recordedAt: '2026-10-21T22:05+08:00' },
    'scratch-en': { text: 'local words', source: 'this session (2026-11-14T08:32-03:00)', recordedAt: '2026-11-14T08:32-03:00' },
  }
  Object.keys(expectWords).forEach((k) => {
    const got = words.parseOriginalWords(bodies[k])
    const want = expectWords[k]
    check(got.length === 1 && got[0].text === want.text && got[0].source === want.source && got[0].recordedAt === want.recordedAt,
      k + ': maintainer\'s words read verbatim with source and time (got ' + JSON.stringify(got) + ')')
  })

  // —— 2. Writers write English and keep what is already there ——
  const NEW = { percent: 90, note: 'new entry', updatedAt: '2026-11-14T09:00:00-03:00' }
  const NEW_LINE = '- Progress: 90% (2026-11-14T09:00:00-03:00): new entry'
  Object.keys(bodies).forEach((k) => {
    const res = progress.applyProgressEntry(bodies[k], NEW)
    const next = String(res.next || '')
    check(res.problem === '' && next.indexOf('## Progress\n\n' + NEW_LINE) >= 0, k + ': a new progress entry is written in English under "## Progress"')
    check(!/^##\s*进度/m.test(next), k + ': no Chinese progress heading is left next to the English one')
    check(progress.progressReadbackProblem(NEW, next, bodies[k]) === '', k + ': the progress read-back check passes and the rest of the body is untouched')
    const before = progress.parseProgressDetail(bodies[k]).entries.length
    check(progress.parseProgressDetail(next).entries.length === before + 1, k + ': every older progress entry is still there')
  })
  const zhWritten = String(progress.applyProgressEntry(bodies['github-zh'], NEW).next || '')
  check(zhWritten.indexOf('- 进度：10%（时间未记录）：老记录') >= 0, 'github-zh: an old Chinese entry is kept character for character')
  const glZh = String(progress.applyProgressEntry(bodies['gitlab-zh'], NEW).next || '')
  check(glZh.indexOf('- Progress: 30% (time not recorded)') >= 0 && glZh.indexOf('旧的自由文字。') >= 0, 'gitlab-zh: the percent in an old heading becomes an English "time not recorded" entry, the free text stays')

  const ENTRY = { text: 'a new line of words', source: 'https://github.com/risaddex/dsh-skills-deck/issues/10#new' }
  Object.keys(bodies).forEach((k) => {
    const res = words.applyOriginalWordsEntry(bodies[k], ENTRY, progress.PROGRESS_BODY_LIMIT)
    const next = String(res.next || '')
    check(res.problem === '' && next.indexOf('Source: ' + ENTRY.source + '\n> ' + ENTRY.text) >= 0, k + ': a new entry is written with an English "Source:" line')
    const got = words.parseOriginalWords(next)
    check(got.length === 2 && got[0].text === expectWords[k].text && got[1].text === ENTRY.text, k + ': the old entry stays first, the new one is appended after it')
    check(next.split('\n').filter((l: string) => /^##\s*(?:维护者原话|Maintainer['\u2019]s words)\s*$/.test(l)).length === 1, k + ': still exactly one maintainer\'s-words section (the existing heading is reused, not duplicated)')
    check(words.originalWordsPresenceProblem(ENTRY, next) === '', k + ': the read-back check finds the new entry')
  })
  const fresh = words.replaceOriginalWordsSection('## 目的\n\n旧目的。\n\n## 边界\n\nx\n', ENTRY)
  check(fresh.indexOf("## Maintainer's words") > fresh.indexOf('旧目的。') && fresh.indexOf("## Maintainer's words") < fresh.indexOf('## 边界'), 'a new section gets the English heading and goes right after a Chinese "## 目的"')
  const freshEn = words.replaceOriginalWordsSection('## Purpose\n\nA purpose.\n\n## Scope\n\nx\n', ENTRY)
  check(freshEn.indexOf("## Maintainer's words") > freshEn.indexOf('A purpose.') && freshEn.indexOf("## Maintainer's words") < freshEn.indexOf('## Scope'), 'a new section goes right after an English "## Purpose"')
  check(words.applyOriginalWordsEntry(bodies['github-zh'], { text: expectWords['github-zh'].text, source: expectWords['github-zh'].source }, progress.PROGRESS_BODY_LIMIT).skipped === true, 'writing a Chinese entry again is still skipped as a duplicate')
  // The reviewer's two questions: a Chinese heading is converted in place (never a second section), and
  // a section that mixes English and Chinese records keeps newest-first order with the new record on top.
  const mixedBody = fixture('mixed-progress.md')
  const mixedRead = progress.parseProgressDetail(mixedBody)
  check(mixedRead.entries.map((e: any) => e.percent).join(',') === '60,40,20' && mixedRead.percent === 60, 'mixed records: the newest record is read first, whatever its language')
  const mixedWritten = String(progress.applyProgressEntry(mixedBody, NEW).next || '')
  const mixedAfter = progress.parseProgressDetail(mixedWritten)
  check(mixedAfter.entries.map((e: any) => e.percent).join(',') === '90,60,40,20', 'mixed records: after a write the order is new, then the old records unchanged')
  check(mixedWritten.split('\n').filter((l: string) => /^##\s*(?:进度|Progress)/.test(l)).length === 1 && mixedWritten.indexOf('## Progress\n') === 0, 'mixed records: the Chinese heading is converted in place to one "## Progress" heading')
  const ensured = minimalSpec.ensureBody('Some body.', 'issue')
  check(ensured.added.indexOf('## Progress') >= 0 && /^## Progress$/m.test(ensured.body), 'a new ticket body gets an English "## Progress" heading')
  check(minimalSpec.ensureBody(bodies['github-zh'], 'issue').added.length === 0, 'a body with a Chinese progress heading gets no second progress section')

  // —— 3. The local Markdown file keeps its structure in both languages ——
  ;['scratch-zh.md', 'scratch-en.md'].forEach((name) => {
    const text = fixture(name)
    const comments = commentFormat.parseComments(text)
    check(comments.length === 1 && /第一条评论|first comment/.test(comments[0].body), name + ': the comment section is cut at the right place')
    check(/本地进度|local progress/.test(commentFormat.sectionTextOf(text, 'Progress')) && /本地进度|local progress/.test(commentFormat.sectionTextOf(text, '进度')), name + ': the progress section is found by its English and its Chinese name')
    check(/本地原话|local words/.test(commentFormat.sectionTextOf(text, "Maintainer's words")) && commentFormat.sectionTextOf(text, 'Purpose').length > 0, name + ': the maintainer\'s-words and purpose sections are found in both languages')
    const incoming = text.replace(/\n## (?:维护者原话|Maintainer's words)[\s\S]*?(?=\n## (?:进度|Progress))/, '')
    check(patchBody.checkNoWorseForPatch(text, incoming) !== '', name + ': losing the maintainer\'s-words section on a whole-body write is refused')
    const merged = patchBody.mergeWholeBodyForPatch(incoming, text)
    check(/本地原话|local words/.test(merged) && patchBody.checkNoWorseForPatch(text, merged) === '', name + ': a whole-body write moves the maintainer\'s words back from disk')
  })
  const lateComment = commentFormat.parseComments('# t\n\n## Comments\n\n### bob — 2026-11-14T11:00:00.000Z\n\ntext\n\n## Progress\n\n- Progress: 5% (time not recorded)\n')
  check(lateComment.length === 1 && lateComment[0].body === 'text', 'an English "## Progress" after the comments ends the comment section (it is not read as comment text)')

  // —— 4. The GitHub pending-labels section: one shape written, both shapes replaced ——
  const issuesSrc = fs.readFileSync(path.join(ROOT, 'src/tracker/rooms/github/write/issues.ts'), 'utf8')
  check(issuesSrc.indexOf("'## Labels still to add (read-only, not written)") >= 0, 'the pending-labels section is written with an English heading')
  check(/待补标签\.\+未落盘/.test(issuesSrc) && /Labels still to add \\\(read-only, not written\\\)/.test(issuesSrc), 'the pending-labels matcher accepts the Chinese and the English heading')

  console.log('\n' + (failed ? 'FAILED' : 'all passed — #10 (' + total + ' checks)'))
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('  FAIL exception: ' + ((e && e.stack) || e)); process.exit(1) })

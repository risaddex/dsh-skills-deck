import fs from 'node:fs'

export type GitRunner = (command: string, args: string[]) => string

/** 只把干净检出的固定提交作为来源；构建期间切换 HEAD 或改写已跟踪文件都必须停止。 */
export function requireCleanSource(run: GitRunner, expected?: string): string {
  const head = run('git', ['rev-parse', 'HEAD'])
  if (expected && head !== expected) throw new Error('Source HEAD changed during release preparation')
  if (run('git', ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Tracked source tree must be clean before and after building')
  return head
}

/** 已接受失败的登记仅供说明，不能替下一次发布授权；推送只接受该来源提交的完整全绿报告。 */
export function requireVerifiedSource(file: string, source: string): void {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (report.head !== source || report.tier !== 'full' || report.stepsRan !== report.stepsTotal || !(report.stepsTotal > 0)
    || report.red !== 0 || report.smoke?.ran !== true || report.smoke.red !== 0
    || !(report.smoke.stepsTotal > 0) || report.smoke.stepsRan !== report.smoke.stepsTotal) {
    throw new Error('Push requires a complete green verify:parallel report for the exact source HEAD; known reds are not future release approval')
  }
}

/** 重试通知前同时比较远端标签对象和解引用提交，拒绝轻量标签或被移走的标签。 */
export function notifyPublishedTag(run: GitRunner, tag: string): void {
  if (!/^dist\/v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error('Expected dist/v<version> tag')
  const ref = 'refs/tags/' + tag
  if (run('git', ['cat-file', '-t', ref]) !== 'tag') throw new Error('Release tag must be annotated')
  const object = run('git', ['rev-parse', ref])
  const commit = run('git', ['rev-parse', ref + '^{}'])
  const remote = new Map(run('git', ['ls-remote', 'origin', ref, ref + '^{}']).split(/\r?\n/).filter(Boolean).map(line => {
    const [sha, name] = line.split(/\s+/)
    return [name, sha]
  }))
  if (remote.get(ref) !== object || remote.get(ref + '^{}') !== commit) throw new Error('Remote release tag SHA does not match the local annotated tag and commit; notification refused')
  run('gh', ['api', 'repos/risaddex/dsh-plugins/dispatches', '-f', 'event_type=skills-deck-dist-tag', '-f', 'client_payload[tag]=' + tag])
}

/** 分支和标签必须一起成功；原子推送失败时绝不能发送成功通知。 */
export function pushAndNotify(run: GitRunner, tag: string): void {
  run('git', ['push', '--atomic', 'origin', 'refs/heads/dist:refs/heads/dist', 'refs/tags/' + tag + ':refs/tags/' + tag])
  notifyPublishedTag(run, tag)
}

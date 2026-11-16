import fs from 'node:fs'

/** 分类只解释失败，绝不改变门禁的退出判据；登记损坏时拒绝把失败当作已接受。 */
export function loadKnownReds(file: string): Set<string> {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(data.failures)) throw new Error('Known-red register requires failures')
  const names = new Set<string>()
  for (const row of data.failures) {
    if (!/^tests\/verify-[a-z0-9-]+\.ts$/.test(row.file) || !row.note?.trim() || names.has(row.file)) throw new Error('Invalid or duplicate known-red entry')
    names.add(row.file)
  }
  return names
}

/** 已绿的基线条目不是失败；未登记的主链和冒烟失败都必须醒目标出。 */
export function classifyReds<T extends {file: string; code: number}>(results: T[], accepted: Set<string>): {known: T[]; fresh: T[]} {
  const red = results.filter(r => r.code !== 0)
  return {known: red.filter(r => accepted.has(r.file)), fresh: red.filter(r => !accepted.has(r.file))}
}

/**
 * src/shared/issue-file/src/original-words-tool.ts —— deck 工具面收 `originalWords` 参数的唯一真源（#1091）
 *
 * 为什么单独一份：参数收口与写入规则分开住（与 #1090 的 progress-tool.ts 同一形态）：
 * original-words.ts 只管正文里的字符串怎么读、怎么写；这里只管模型传进来的那个对象能不能收成
 * 「一段原话 + 一个出处」。两边都是纯函数，不碰 ctx、不读文件、不读钟。
 *
 * 约束：不引其它模块（shared 层同层互引被规则禁止）。所以条目类型在这里按同形另写一份，
 * 不 import original-words.ts 的 OriginalWordsEntry —— 与 progress-tool.ts 声明 ProgressEntryLike 同理。
 */

/** 一条维护者原话的入参形状（与 original-words.ts 的 OriginalWordsEntry 同形，故意不 import）。 */
export interface OriginalWordsEntryLike {
  /** 维护者的原话正文，一字不改；可以多行。 */
  text: string
  /** 出处，必填、写成一行。 */
  source: string
}

/**
 * 收 `originalWords` 参数：只认 `{text, source}` 两个字符串字段。
 *
 * 为什么出处必填：没有出处的原话，读的人无法回查是谁在什么时候说的（#1089 定稿要求）。
 * 为什么收不成整笔拒绝：原话是「一字不改」的东西，宁可不写，也不替调用方补一个猜出来的出处。
 *
 * 收成时 text 里的换行统一成 `\n`（CRLF 在引用块里没法稳定切行），其余字符原样保留；
 * source 去掉两端空白后必须还是一行（中间不许有换行）。
 */
export function originalWordsFromArg(arg: unknown): { entry: OriginalWordsEntryLike | null; problem: string } {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    return { entry: null, problem: 'originalWords must be an object with two fields: {text, source}.' }
  }
  const a = arg as Record<string, unknown>
  if (typeof a.text !== 'string' || a.text.trim() === '') {
    return { entry: null, problem: 'text is required: put the maintainer\'s words in verbatim (it cannot be an empty string).' }
  }
  if (typeof a.source !== 'string' || a.source.trim() === '') {
    return { entry: null, problem: 'source is required: a ticket gets its full link, a reply in this session gets "this session (time)", a file gets "path:line", a commit gets its short hash.' }
  }
  const source = a.source.trim()
  if (/[\r\n]/.test(source)) {
    return { entry: null, problem: 'source must be a single line: remove the line breaks (a ticket gets its full link, this session gets "this session (time)").' }
  }
  return { entry: { text: a.text.replace(/\r\n?/g, '\n'), source: source }, problem: '' }
}

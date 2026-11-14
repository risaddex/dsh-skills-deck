// label-colors-errors.js —— 写失败分档（#614 的结论落到这个房间的版本）
//
// 人话：保存没存上时，到底该跟用户说什么，只许这一处定。
// 沙箱拒绝必须能单独辨认——那是插件自己的限制，不是用户的文件权限问题（不许说成「目录不可写」）；
// 其余按路径类 / 占用类 / 只读类 / 空间类给不同的说法；分不出来时归环境档但不说成权限问题。
// 文件位置由调用方递进来（relPath）：调用方手里本来就有这条常量，
// 这里不从别处再引一份，免得房间内部转圈引用。
import { ERROR_KIND } from '../../contract/vocabulary.js'

/** 写失败分档：入参是抛出来的错与文件相对位置，出参是 {kind, message}（直接给用户看）。 */
// kind 注成 string 而不是契约 ErrorKind：冻住的 ERROR_KIND 常量对象成员被拓宽成 string，
// 逐处断言是噪音；返回值恒为那八档之一（实现里只取 ERROR_KIND.ENV），调用方 failAs 收的正是 string。
export function describeWriteFailure(err: unknown, relPath: string): { kind: string; message: string } {
  const rel = String(relPath || '')
  // err 的形状不一（文件服务各实现抛的不一样）：经 Record 视图读码值与文本；
  // 每次访问前都有 `err &&` 守卫（与原来逐字相同的短路），cast 只为过类型。
  const er = err as Record<string, unknown>
  const message = String((err && er.message) || err || '')
  const code = String((err && (er.code || er.kind)) || '')
  if (err && er.readBackMismatch === true) {
    // 这一档能确定的只有「这次没写成功或没写全」，所以动作要带用户把最后一条退路走完：
    // 核对下来内容不对就手动补改，否则再重试一次只会拿到同一句话。
    return { kind: ERROR_KIND.ENV, message: 'Save failed: after writing, the file was read again and its content does not match what was just written, so it cannot be confirmed that the label colors were saved. Open the label color file in the workspace (' + rel + ') and check its content: if it is not the colors you wanted to save, change it by hand to those colors, then save again.' }
  }
  if (code === 'FS_SANDBOX_DENIED' || /file access denied|workspace-write|read-only mode/i.test(message)) {
    return { kind: ERROR_KIND.ENV, message: 'Save failed: the plugin is not allowed to write the label color file into the current workspace (' + rel + '). This limit comes from the plugin side, not from your file permissions, so changing file or folder permissions will not help. Switch to a workspace that allows writing, then retry.' }
  }
  if (/ENOSPC/.test(message) || code === 'ENOSPC') {
    return { kind: ERROR_KIND.ENV, message: 'Save failed: the disk is full, so the label colors were not written into the label color file (' + rel + '). Free up disk space, then retry; this label color file was not changed.' }
  }
  // EPERM / EACCES 在「临时文件 + 改名」这种发布方式下原因不止一种（研究 #614 实测：只读、被别的程序
  // 占用、目标位置被换成目录，三种都会走到改名这一步并抛同一个 EPERM），所以这里不断言单一原因，
  // 把三种可能一并说清，每种都给一句「怎么做能解决」。
  if (/EACCES|EPERM/.test(message) || code === 'EACCES' || code === 'EPERM' || code === 'FS_NOT_REGULAR_FILE') {
    return {
      kind: ERROR_KIND.ENV,
      message: 'Save failed: the label color file in the workspace (' + rel + ') cannot be written. The plugin cannot tell which of the three cases below it is, so handle it by what you actually see: ' +
        '(1) the label color file in the workspace (' + rel + ') is in use by another program (editors, sync folders and antivirus software are common), so close that program and retry; ' +
        '(2) the label color file in the workspace (' + rel + ') or its directory is read-only, so remove the read-only attribute and retry; ' +
        '(3) the label color file in the workspace (' + rel + ') is now a directory, not a file, so delete that directory, restore the file as a file, then retry. ' +
        'This label color file was not changed; you can retry.',
    }
  }
  // 位置不存在与位置是目录这两种情形，要办的事正好相反（一个要建、一个要删），
  // 所以拆成两条各自能照做的说法，并且都写明是在哪一份文件上做；插件认不出是哪一种，照实说。
  if (/ENOENT/.test(message) || code === 'ENOENT' || code === 'EISDIR' || code === 'FS_NOT_FOUND') {
    return {
      kind: ERROR_KIND.ENV,
      message: 'Save failed: the label color file in the workspace (' + rel + ') cannot be written. There are two cases, and the plugin cannot tell which one it is, so handle it by what you actually see: ' +
        '(1) the file does not exist at this location: create this label color file in the workspace (' + rel + '), creating its parent docs/agents/ directory first if it does not exist yet, then retry; ' +
        '(2) this location is now a directory, not a file: delete that directory first, then create this label color file in the workspace (' + rel + '), then retry. ' +
        'In both cases this label color file was not changed.',
    }
  }
  // 认不出来的一律归环境档，并说清责任在插件这边（错误原文不进给用户的文案：
  // 原子写失败时错误里的路径是临时文件名，用户会去找一个不存在的文件）。
  // 「写坏的临时文件已经清掉」这句原来对所有情形都成立、其实只对「改名失败」那一支成立，所以改成
  // 「可能留了一份写到一半的中间文件、可以直接删掉」——直写那条路上没有中间文件，两种情形都说得通。
  return { kind: ERROR_KIND.ENV, message: 'Save failed: the label colors were not written into the label color file in the workspace (' + rel + '), and the plugin cannot recognize the cause. This label color file was not changed. A half-written temporary file may be left in the same directory; you can delete it, it does not affect this file. This is a problem with the plugin runtime environment, not a mistake on your side. Retry once; if it still fails, report the original text of this message to the plugin maintainer.' }
}

export default { describeWriteFailure }

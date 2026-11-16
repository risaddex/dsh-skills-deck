/**
 * src/deck/tools/identity-resolve.ts —— 仓库身份补全的一次完整动作（#22 从 tracker-session.ts 分出）。
 *
 * 为什么单开一个文件：这段动作有三个出口（会话回包里的 ref、回执 cost.note 里的一句注解、
 * 插件日志里的一行），放在一起才看得出是同一件事；而 tracker-session.ts 早过了 20 KB 的分文件阈值，
 * 再往里加就得先把那个文件拆了——那是另一件事，不该混在这次修复里。
 *
 * 三个出口各说什么：
 *   - `ref`：补到了就是完整身份，补不到就是空标识的壳（下游照旧诚实失败，不编身份）；
 *   - `note`：补不到时的那句人话（说清没解析出身份、以及最后一次失败的原因），壳拼进 `cost.note`；
 *   - 日志：一行 `host.call.fail`，`errorKind` 说明是哪一族额度见底，`errorHash` 是那句人话的散列。
 *
 * 事件的选法、字段的含义、为什么不新开事件、为什么不把整句抄进日志，都写在 `logIdentityDegraded` 上。
 */
import { withCap } from '../shell/capped-wait.js'
import { resolveSessionRepoRef } from '../../tracker/session/repo-ref.js'
import { repoRefNoteOf, repoRefNoteClass } from '../../tracker/session/repo-ref-note.js'
import type { RepoRefResolution } from '../../tracker/session/repo-ref.js'
import type { RepositoryRef } from '../../tracker/contract/entities.js'

/** 未知形状的记录（依赖袋与日志口都没标类型，用到哪格验哪格）。 */
type UnknownRecord = Record<string, unknown>

/** 工作区短指纹：与接线层同一个算法（那边是本地一份，这里也自带一份，免得为一个 8 字符散列引出一个环）。 */
function hash8(text: unknown): string {
  let h = 5381;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) >>> 0);
  return ('0000000' + h.toString(16)).slice(-8);
}

/**
 * 把「为什么没补上仓库身份」记进插件日志（#22）。
 *
 * 为什么用 `host.call.fail` 而不新开一个事件名：事件名与字段是三张登记过的表
 * （`tests/verify-log-fields.ts` 的允许字段、`research/489-appendix.md` 的对照表、`tests/verify-log-count.ts`
 * 的条数），为这一句话新开一条要把三张表一起改，换不来更多信息。`host.call.fail` 本来就是
 * 「宿主侧一次调用没成」的那一行，deck 层已经用它记过别的失败（`method: 'deck.toolGate'`、
 * `kind: 'deck-tool'`），四个字段的含义都现成：
 *   - `method`：`deck.repoIdentity`，这次没成的就是仓库身份补全；
 *   - `kind`：`deck-tool`，与 `deck.toolGate` 同一个口径；
 *   - `errorKind`：原因档位（`quota-rest` / `quota-graphql` / `quota-both` / `repo-ref`），
 *     说的正是「哪一族额度见底」；
 *   - `errorHash`：整句原因的散列，同一句话配同一个散列，回执里有原文可对。
 *
 * 为什么不把整句原因抄进日志：`errorKind` 的口径是短档位，整句话里有额度数字、恢复时刻与后端的
 * 措辞，抄进去这一行就变成一段正文。完整那句（哪个通道见底、约几点恢复）进回执的 `cost.note`，
 * 人翻开回执就读到——两处各说该说的那半句。
 *
 * 为什么不用 `guardEmit`（#1182 收进内核的那个壳）：它要一个 `OpContext`，而 deck 这层手上只有
 * 日志口；`src/deck` 里既有写法就是这里这种手写 try/catch（见 `suggest-next-steps.ts`）。
 */
function logIdentityDegraded(logLike: unknown, note: string): void {
  try {
    const log = (logLike || null) as { fire?: (level: string, event: string, fields: UnknownRecord) => void } | null;
    if (!log || typeof log.fire !== 'function') return;
    log.fire('warn', 'host.call.fail', {
      method: 'deck.repoIdentity',
      kind: 'deck-tool',
      errorKind: repoRefNoteClass(note),
      errorHash: hash8(note),
    });
  } catch { /* 记不上日志不能翻掉这次调用 */ }
}

/** 一次补齐要的料（全是接线层手上现成的东西）。 */
export interface IdentityResolveInput {
  /** 会话（describe 与 getRepoKey 两条定位口都在它上面）。 */
  session: unknown;
  /** 工作区目录。 */
  cwd: string;
  /** 这次选中的后端编号。 */
  backendId: string;
  /** 判定出口带来的那份身份（可能只带部分字段）。 */
  fromSelection: RepositoryRef | null;
  /** 会话操作的基础上下文（平台 / 文件 / 起进程 / 计时器）。 */
  baseCtx: UnknownRecord;
  /** 远端定位那一笔的调用方标签。 */
  caller: string;
  /** 补全整段的等待上限（毫秒）。 */
  cap: number;
  /** 等待口（缺席时用真定时器）。 */
  wait?: (ms: number) => Promise<unknown>;
  /** 插件日志口（`{ fire }`；缺席就只留回执那一半）。 */
  log?: unknown;
}

/** 补齐的结局：补到的身份（可能是空标识的壳）与那句注解（补到了就是空串）。 */
export interface IdentityResolveResult {
  ref: RepositoryRef | null;
  note: string;
}

/**
 * 补全仓库身份，并把「补不上」的原因留给回执与日志。
 * 永不抛：补不上就是空标识加一句注解，调用方照旧往下走（下游诚实失败）。
 */
export async function resolveIdentityWithNote(input: IdentityResolveInput): Promise<IdentityResolveResult> {
  const resolved = await withCap(
    resolveSessionRepoRef({
      session: input.session as never,
      cwd: input.cwd,
      backendId: input.backendId,
      fromSelection: input.fromSelection,
      baseCtx: input.baseCtx as never,
      caller: input.caller,
    }),
    input.cap,
    input.wait as never,
  );
  const maybe = (resolved.ok === true) ? (resolved.value as RepoRefResolution | null) : null;
  const ref = (maybe && maybe.ref) ? maybe.ref : null;
  if (ref && ref.refId) return { ref: ref, note: '' };
  // 超时那一支也走同一个拼法：把「没走完」当成一条 step 原因交给它，两句头就不必各写一份
  // （各写一份的下场是两处措辞迟早不一样，读起来像两种毛病）。
  const note = (resolved.ok === true)
    ? repoRefNoteOf(maybe)
    : repoRefNoteOf({
        ref: null,
        via: 'none',
        steps: [{ step: 'remote-locate', ok: false, error: 'the identity chain did not finish within the waiting limit (' + String(input.cap) + ' ms)' }],
      });
  logIdentityDegraded(input.log, note);
  return { ref: ref, note: note };
}

/** 把几句注解拼成回执 `cost.note` 那一格（空的丢掉，顺序就是给的顺序）。 */
export function combineNotes(...parts: unknown[]): string {
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (typeof part === 'string' && part.length > 0) kept.push(part);
  }
  return kept.join('; ');
}

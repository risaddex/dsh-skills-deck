/**
 * src/deck/tools/deck-default-admit.ts —— 依赖袋没配裁决口时的兜底裁决（#22 从 tracker-session.ts 分出）。
 *
 * 为什么单开一个文件：tracker-session.ts 早过了 20 KB 的分文件阈值，而这次要在那里加仓库身份注解的接线。
 * 与其把那个文件撑得更大，不如把这一支独立的兜底搬出来——它只依赖 `num` 与 `aiToolFloor` 两个小东西，
 * 与接线层其余部分没有别的关系，搬家不改行为。
 *
 * 口径必须与参考裁决一致（见 `src/tracker/contract/budget-model.ts`）：硬顶先行、读数未知与离网放行、
 * 已知耗尽才推迟。这里是「依赖袋没给 admit」时才走的一支，生产上由 `deck-tool-bridge.ts` 的
 * `decideByBudget` 回答同一个问题。
 */

// 保底线取中央那份（config 里定的 5%），不在这里手写第二份数字。
import { aiToolFloor } from '../../refresh/kernel/host-budget.js'

/** 未知形状的记录：本文件只按用到的格取值。 */
type UnknownRecord = Record<string, unknown>

/** 数字兜底（非数字一律按 0）；与接线层同名同算法的一份小工具，不引那边造成环。 */
function num(v: unknown): number { return (typeof v === 'number' && isFinite(v)) ? v : 0 }

/** 依赖袋没配裁决口时的兜底（与参考裁决同口径：硬顶先行、未知与离网放行、已知耗尽推迟，见 budget-model.ts）。 */
export async function fallbackAdmit(input: UnknownRecord): Promise<UnknownRecord> {
  const op = String(input.op || '');
  const model = (input.budget || {}) as UnknownRecord;
  const reading = (input.reading || {}) as UnknownRecord;
  const writes = ['create', 'close', 'reopen', 'comment', 'update', 'setLabels', 'setAssignees', 'setParent', 'setBlockedBy'];
  if (writes.indexOf(op) >= 0 && input.canWrite === false) return { allowed: false, kind: 'rate-limit', reason: 'hard-cap', message: 'Hard cap: this call has no write permission, so the write is refused outright.' };
  if (!reading || reading.known === false) return { allowed: true, reason: 'unknown-reading' };
  if (model.kind === 'off-network' || reading.kind === 'off-network') return { allowed: true, reason: 'off-network' };
  const levels: Array<{ remaining: number; limit: number }> = [];
  if (reading.kind === 'requests-only') levels.push((reading.requests || {}) as { remaining: number; limit: number });
  else if (reading.kind === 'two-buckets') {
    const buckets = (reading.buckets || {}) as UnknownRecord;
    if (model.kind === 'requests-only') levels.push((buckets.rest || {}) as { remaining: number; limit: number });
    else if (model.independentBuckets) levels.push((buckets.rest || {}) as { remaining: number; limit: number }, (buckets.graphql || {}) as { remaining: number; limit: number });
    else levels.push((buckets.graphql || {}) as { remaining: number; limit: number });
  }
  // #1527：保底线改成服务端上限的 5%（以前是本桶份额的 30%），文案照实报服务端剩余与保底，不让人猜。
  for (const level of levels) {
    if (num(level.remaining) <= aiToolFloor(num(level.limit))) return { allowed: false, kind: 'rate-limit', reason: 'exhausted', message: 'Quota exhausted: the server still has ' + num(level.remaining) + ' (limit ' + num(level.limit) + ', floor ' + aiToolFloor(num(level.limit)) + '), so this call is not executed now.' };
  }
  return { allowed: true, reason: 'sufficient' };
}

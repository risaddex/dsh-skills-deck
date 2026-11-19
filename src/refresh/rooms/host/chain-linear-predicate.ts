// src/refresh/rooms/host/chain-linear-predicate.ts —— 检查链里 Linear 绑定那一项判据的注册口（#65）。
//
// 为什么单开一个文件：check-chain-evaluation.ts 已贴着 350 有效行的上限（tests/verify-file-granularity.ts），
//   而这一项只需要「把房间那份判据按检查项 id 挂进谓词表」这一件事，与链的编排无关。
// 什么约定不能改：
//   1. 判据本体在 Linear 房间（src/tracker/rooms/linear/binding-check.ts），只经装配点 src/tracker/registry/builtins.ts 取出；
//      这里不 import 房间，也不另写一遍「文件里有没有 alias」的判断。
//   2. 键是 backend:linear:bindingDeclared，与 LINEAR_CATALOG 里那一项的 check 描述逐字对应。
//   3. 取不到判据、读文件失败一律回 pending（诚实未知），不冒充 fail：界面看到的是「没量出来」，不是「没绑定」。
type PredicateResultView = { status: 'pass' | 'fail' | 'pending'; detail: string }
type PredicateRegistryLike = { register(key: string, fn: (check: unknown, pctx?: { cwd?: string } | null) => Promise<PredicateResultView>): unknown }

export function registerLinearBindingPredicate(registry: PredicateRegistryLike, base: { platform: unknown; cwd: string; lang: string }): void {
  try {
    registry.register('backend:linear:bindingDeclared', async function (_check, pctx) {
      try {
        const builtinsMod = await import('../../../tracker/registry/builtins.js')
        const extras = await builtinsMod.loadLinearHostExtras()
        return await extras.checkLinearBinding({ platform: base.platform, cwd: (pctx && pctx.cwd) || base.cwd, lang: base.lang })
      } catch (e) { return { status: 'pending', detail: String((e as { message?: unknown } | null | undefined)?.message || e).slice(0, 600) } }
    })
  } catch { /* 重复注册等同于已有：保持谓词表原样 */ }
}

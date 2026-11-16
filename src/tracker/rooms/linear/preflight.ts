/**
 * src/tracker/rooms/linear/preflight.ts —— 环境预检：这枚凭据还能不能用
 *
 * 预检只判环境（契约里那句）：凭据在不在、连不连得上、认出来的是谁。它**不**判「这个工作区
 * 绑定对不对」——那是判定层的事。所以这里只发一次身份探针，成功就是通。
 */
import type { OpContext } from '../../contract/contexts.js'
import type { PreflightResult } from '../../contract/results.js'
import { gql, type LinearAccount } from './client.js'
import { IDENTITY_QUERY } from './queries.js'

/** 探针回来的身份：报告里要说出「连上的是谁」，只说 ok 等于没说。 */
export interface LinearIdentity {
  viewer: string
  organization: string
  organizationUrlKey: string
}

export async function preflightLinear(ctx: OpContext, account: LinearAccount): Promise<PreflightResult> {
  const result = await gql<{
    viewer?: { name?: string; displayName?: string; organization?: { name?: string; urlKey?: string } | null }
  }>(ctx, account, { query: IDENTITY_QUERY, bucket: 'probe' })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true }
}

/** 同一趟探针的完整读数，给设置页与诊断用；预检本身只要通不通。 */
export async function readIdentity(ctx: OpContext, account: LinearAccount): Promise<LinearIdentity | null> {
  const result = await gql<{
    viewer?: { name?: string; displayName?: string; organization?: { name?: string; urlKey?: string } | null }
  }>(ctx, account, { query: IDENTITY_QUERY, bucket: 'probe' })
  if (!result.ok) return null
  const viewer = result.data.viewer
  if (!viewer) return null
  return {
    viewer: String(viewer.displayName || viewer.name || ''),
    organization: String(viewer.organization?.name || ''),
    organizationUrlKey: String(viewer.organization?.urlKey || ''),
  }
}

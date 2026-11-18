// tests/lib/verify-45-detail-env.ts: the shared environment of the four verify-45-detail-* gates (#45).
//
// Why this file exists: the detail-page gates of #45 (verify-45-detail-routes-by-key, verify-45-detail-issue-rows-by-key,
// verify-45-detail-map-page-by-key and verify-45-detail-capsule-by-key) used to be one 30 KB file. They were split by section
// so each file stays small, and everything they all need moved here: the global stubs the built client closure normally provides,
// the dynamic imports of the REAL source modules the stubs point at, and the recorders that capture what the code under test
// hands to the navigation, the clipboard, the tracker opener and the input box.
//
// Importing this file has side effects on purpose: it installs the globals on `globalThis`. Every gate file runs in its own
// process, so nothing leaks between gates. A section that must delete or restore a global (the "without rowNavKeyOf in scope"
// check) does that inside its own gate file, never here.
//
// How a gate uses it:
//   import { g, show, urlOf, navCalls, makeChecker, realConsoleError } from './lib/verify-45-detail-env.ts'
//   const { check, stats } = makeChecker()
//   ...sections...
//   console.error = realConsoleError
//   printGateResult('verify-45-detail-xxx', stats.assertions, stats.failed)
//   if (stats.failed) process.exit(1)
// `check` counts per gate file (each call to makeChecker keeps its own counter), so each gate's own GATE-RESULT line is correct.
import React from 'react'

/** Creates one assertion counter. `stats` is live: read it after the last check, when the gate prints its GATE-RESULT line. */
export function makeChecker(): { check: (ok: boolean, msg: string) => void, stats: { assertions: number, failed: number } } {
  const stats = { assertions: 0, failed: 0 }
  const check = (ok: boolean, msg: string): void => { stats.assertions += 1; if (!ok) stats.failed += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg) }
  return { check, stats }
}

export const show = (v: any): string => JSON.stringify(v)

export const g: any = globalThis
g.React = React
g.tr = (key: any, params?: any): string => { let s = String(key); if (params) s = s.replace(/\{(\w+)\}/g, (m: string, n: string) => (n in params ? String(params[n]) : m)); return s }
g.emit = () => {}
g.Ic = (props: any) => '[' + ((props && props.n) || '?') + ']'
g.Tip = (props: any) => React.createElement('span', { 'data-tip': String(props.content) }, props.children)
export const realConsoleError = console.error
console.error = (...args: any[]) => { const m = String((args && args[0]) || ''); if (m.indexOf('unique "key" prop') >= 0 || m.indexOf('useLayoutEffect does nothing on the server') >= 0) return; realConsoleError.apply(console, args) }

const identity = await import('../../src/tracker/kernel/identity-keys.ts')
g.effortOf = identity.effortOf; g.idOfParts = identity.idOfParts; g.idOf = identity.idOf
const link = await import('../../src/client/kernel/link.ts')
g.issueUrlFor = link.issueUrlFor; g.openIssueUrl = link.openIssueUrl; g.openModeFor = link.openModeFor
const cv: any = await import('../../src/client/kernel/container-view.ts')
for (const n of ['containerKindOf', 'containerStateOf', 'containerTriState', 'CONTAINER_ACCENT']) g[n] = cv[n]
const { findMapByIdentity } = await import('../../src/client/kernel/store-derived.ts')
g.findMapByIdentity = findMapByIdentity
const { rowNavKeyOf } = await import('../../src/client/kernel/link.ts')
g.rowNavKeyOf = rowNavKeyOf

// Everything the code under test hands to the navigation, the clipboard, the tracker opener and the input box is recorded here.
export const navCalls: any[] = []
export const copied: any[] = []
export const opened: any[] = []
export const injected: any[] = []
g.pushNav = (_st: any, kind: any, n: any, eid: any) => { navCalls.push({ kind, n, eid }) }
g.popNav = () => {}
g.copyText = async (_st: any, url: any) => { copied.push(url); return true }
g.openTrackerTarget = (_st: any, key: any) => { opened.push(key) }
g.inject = (_st: any, text: any) => { injected.push(text) }
g.openInNewSession = () => {}
export const subMod: any = await import('../../src/client/views/subIssueRouting.ts')
g.enterSubDetail = subMod.enterSubDetail

export const urlOf = (key: string) => 'https://tracker.example/issue/' + key

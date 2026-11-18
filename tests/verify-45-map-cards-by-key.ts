// tests/verify-45-map-cards-by-key.ts: the map detail page hands its text key to every navigation, link, copy and prompt seam (#45).
//
// Why this gate exists: Linear ticket keys are text (`OMB-903`). The host fills a row's numeric `number` only when the key is all digits,
// so a Linear row has no usable `number`. The map detail page (cards, header, top bar, bottom action bar) passed `row.number` to
// pushNav, issueUrlFor, openTrackerTarget, copyText and the prompt builders, so a card click pushed an empty value (the navigation
// refuses it, nothing opened), the copy button wrote an empty address, the open-in-tracker button had no address and the injected
// prompts named no ticket. The list row was fixed first (verify-45-list-row-opens-by-key.ts); this gate renders the REAL map detail
// page per row shape and calls what the user clicks. The ticket row inside a map detail is in verify-45-ticket-row-by-key.ts; both
// share the stubs in tests/lib/verify-45-map-cards-env.ts.
// Rule under test: a row whose key is all digits passes exactly what it passed before (GitHub 42, Markdown 1, container 0);
// a row whose key is text passes that text key (Linear OMB-903), whatever its `number` is (absent, null or a made-up 0).
// 门禁归属: src/client/views/MapDetail.ts, src/client/views/MapDetailHead.ts, src/client/views/MapDetailTop.ts, src/client/views/DetailActionBar.ts
// Run: node --import ./scripts/ts-hook.mts tests/verify-45-map-cards-by-key.ts
import { printGateResult } from './lib/gate-result.ts'
import { rec, tick, urlOf, elOf, tipsOf, ev, SHAPES, keyLog, drawMap, makeChecker, realConsoleError } from './lib/verify-45-map-cards-env.ts'

const { check, stats } = makeChecker()

for (const s of SHAPES) {
  for (const urlKind of ['http', 'file']) {
    const tag = s.name + ' [' + urlKind + ' address]'
    const p = drawMap(s, urlKind)
    const childKey = keyLog(p.issueRow)
    const subWant = s.subWant
    const cardUrl = urlOf(p.issueRow.key, urlKind)

    // --- the ticket card: click, copy, open-in-tracker, tooltips, displayed number ---
    rec.push.length = 0
    const card = elOf('map.card.' + childKey)
    check(!!card && typeof card.props.onClick === 'function', tag + ': the ticket card is drawn with a click handler')
    if (card) card.props.onClick(ev)
    check(rec.push.length === 1 && rec.push[0].kind === 'issue' && rec.push[0].n === s.childWant, tag + ': clicking the ticket card pushes issue ' + JSON.stringify(s.childWant) + ' (it pushed ' + JSON.stringify(rec.push[0] && rec.push[0].n) + ')')
    rec.push.length = 0
    const subCard = elOf('map.card.' + keyLog(p.mapRow))
    if (subCard) subCard.props.onClick(ev)
    check(rec.push.length === 1 && rec.push[0].kind === 'map' && rec.push[0].n === subWant, tag + ': clicking the sub-map card pushes map ' + JSON.stringify(subWant) + ' (it pushed ' + JSON.stringify(rec.push[0] && rec.push[0].n) + ')')
    check(p.html.includes('#' + childKey) && !p.html.includes('#undefined'), tag + ': the card shows #' + childKey + ' and no #undefined anywhere on the page')
    rec.copied.length = 0; rec.toast.length = 0
    const copyEl = elOf('map.card.copy.' + childKey)
    if (copyEl) copyEl.props.onClick(ev)
    await tick()
    check(rec.copied.length === 1 && rec.copied[0] === cardUrl, tag + ': the card copy button writes the ticket address (' + String(rec.copied[0]) + ')')
    check(rec.toast[0] === 'toast.copiedLink@n=' + String(s.childWant), tag + ': the copy toast names the ticket (' + String(rec.toast[0]) + ')')
    const tips = tipsOf()
    check(tips.includes('tip.newSession@n=' + String(s.childWant)), tag + ': the card new-session tooltip names ' + String(s.childWant))
    check(tips.includes('list.openInTrackerTitle@n=' + String(s.childWant)), tag + ': the card open-in-tracker tooltip names ' + String(s.childWant))
    const linkEl = elOf('map.card.link.' + childKey)
    if (urlKind === 'http') check(!!linkEl && linkEl.props.href === cardUrl, tag + ': the card link points at the ticket address (' + String(linkEl && linkEl.props.href) + ')')
    else {
      rec.host.length = 0
      if (linkEl) linkEl.props.onClick(ev)
      check(rec.host.length === 1 && rec.host[0].args && (rec.host[0].args.path || rec.host[0].args.file) === cardUrl, tag + ': the card link button opens the ticket file (' + JSON.stringify(rec.host[0]) + ')')
    }

    // --- the page itself: breadcrumb, header, top bar, bottom bar ---
    check(p.html.includes('panel.tabList / #' + String(s.mapWant)) && !p.html.includes('/ #undefined'), tag + ': the breadcrumb ends with #' + String(s.mapWant))
    check(rec.fold.length > 0 && rec.fold.every((n) => n === s.mapWant), tag + ': the top bar fold hook gets ' + JSON.stringify(s.mapWant) + ' (got ' + JSON.stringify(rec.fold) + ')')
    check(tips.includes('tip.openInTracker@n=' + String(s.mapWant)), tag + ': the top bar open-in-tracker tooltip names ' + String(s.mapWant))
    const mapUrl = urlOf(s.map.key, urlKind)
    rec.copied.length = 0; rec.toast.length = 0
    const topCopy = elOf('map.top.copy')
    if (topCopy) topCopy.props.onClick(ev)
    check(rec.copied.length === 1 && rec.copied[0] === mapUrl && rec.toast[0] === 'toast.copiedLink@n=' + String(s.mapWant), tag + ': the top bar copy button writes the map address and names ' + String(s.mapWant) + ' (' + String(rec.copied[0]) + ', ' + String(rec.toast[0]) + ')')
    const topLink = elOf('map.top.link')
    if (urlKind === 'http') check(!!topLink && topLink.props.href === mapUrl, tag + ': the top bar link points at the map address (' + String(topLink && topLink.props.href) + ')')
    else {
      rec.host.length = 0
      if (topLink) topLink.props.onClick(ev)
      check(rec.host.length === 1 && (rec.host[0].args.path || rec.host[0].args.file) === mapUrl, tag + ': the top bar link button opens the map file (' + JSON.stringify(rec.host[0]) + ')')
    }
    check(p.html.includes('>list.openInTrackerTitle@n=' + String(s.mapWant) + '<'), tag + ': the header open-in-tracker button (shown when loading the cards failed) names ' + String(s.mapWant))
    const head = elOf('map.head.open')
    if (urlKind === 'file') {
      rec.host.length = 0
      if (head) head.props.onClick(ev)
      check(rec.host.length === 1 && (rec.host[0].args.path || rec.host[0].args.file) === mapUrl, tag + ': the header open button opens the map file (' + JSON.stringify(rec.host[0]) + ')')
    }
    const archive = elOf('map.dest.archive')
    if (urlKind === 'http') check(!!archive && archive.props.href === mapUrl, tag + ': the bottom archive link points at the map address (' + String(archive && archive.props.href) + ')')
    else {
      rec.host.length = 0
      if (archive) archive.props.onClick(ev)
      check(rec.host.length === 1 && (rec.host[0].args.path || rec.host[0].args.file) === mapUrl, tag + ': the bottom archive button opens the map file (' + JSON.stringify(rec.host[0]) + ')')
    }
  }

  // --- the three states of the main buttons: what each injects names the right map ---
  const STATES: Array<[string, any, string]> = [
    ['empty', { total: 0, closed: 0, levels: [] }, 'INSPECT:' + String(s.mapWant)],
    ['open', { total: 2, closed: 1, levels: [{ open: 1, closed: 1, total: 2 }] }, 'START:' + String(s.mapWant)],
    ['done', { total: 2, closed: 2, levels: [{ open: 0, closed: 2, total: 2 }] }, 'COMPLETE:' + String(s.mapWant)],
  ]
  for (const [state, stats, want] of STATES) {
    const p = drawMap(s, 'http', { stats })
    for (const log of ['map.top.exec', 'map.dest.exec']) {
      rec.injected.length = 0
      const b = elOf(log)
      if (b) b.props.onClick(ev)
      check(rec.injected.length === 1 && rec.injected[0] === want, s.name + ' [' + state + ']: ' + log + ' injects ' + want + ' (it injected ' + JSON.stringify(rec.injected[0]) + ')')
    }
    void p
  }
}

// A Linear spec (a container that is not an exploration map) injects the skill call with its own ticket address in all three states.
{
  const s = SHAPES[SHAPES.length - 3]
  const url = urlOf(s.map.key, 'http')
  const SPEC_STATES: Array<[string, any, string]> = [
    ['empty', { total: 0, closed: 0, levels: [] }, 'FOR:specSplit:' + url],
    ['open', { total: 2, closed: 1, levels: [{ open: 1, closed: 1, total: 2 }] }, 'FOR:specExecute:' + url],
    ['done', { total: 2, closed: 2, levels: [{ open: 0, closed: 2, total: 2 }] }, 'FOR:specComplete:' + url],
  ]
  for (const [state, stats, want] of SPEC_STATES) {
    drawMap(s, 'http', { stats, spec: true })
    for (const log of ['map.top.exec', 'map.dest.exec']) {
      rec.injected.length = 0
      const b = elOf(log)
      if (b) b.props.onClick(ev)
      check(rec.injected.length === 1 && rec.injected[0] === want, 'Linear spec [' + state + ']: ' + log + ' injects ' + want + ' (it injected ' + JSON.stringify(rec.injected[0]) + ')')
    }
  }
}
console.error = realConsoleError
printGateResult('verify-45-map-cards-by-key', stats.assertions, stats.failed)
if (stats.failed) process.exit(1)

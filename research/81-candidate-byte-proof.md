# #81 — why the candidate byte proof cannot pass

**Conclusion:** `release-dist --push --candidate` cannot succeed for any release of this plugin today,
for two independent reasons that this note records with the evidence needed to re-check them.

## Cause 1 — the two builds write different bytes

The verification build is declared in `verify/profile.ts` as `node ../verify/build.mjs --pkg-only`.
`verify/build.mjs` runs `scripts/build.mts` and then prepends the identity banner
`/*! dsh-skills-deck v<version> */` to `lib/client.js` (29 characters plus a newline, 30 bytes).

The publish path, `scripts/release-dist.mts`, runs `scripts/build.mts --force` itself and never writes
that line. `scripts/build.mts` contains no banner writing at all.

Evidence that the direction is the one described: `git show dist/v2.1.1:lib/client.js` begins with the
`/**` source comment, so the published artifact does not carry the banner while the candidate does.

Both fingerprints are computed over npm-packed tarballs, and npm never packs `package-lock.json`; the
published dist tree carries none. So `package-lock.json` plays no part in the difference — the only
content difference is the banner in `lib/client.js`.

## Cause 2 — the audit valve is unreachable when the two commits are equal

`scripts/release-dist.mts` reads `auditCovered` by scanning the gate output for the literal
`PREFLIGHT-CANDIDATE-AUDIT`. `scripts/lib/release-preflight-gate.mts` emits that line only in the branch
where `report.candidate.commit !== releaseCommit` and `report.audit.required && report.audit.covered`.

The base gate (`judgeAncestorAudit`) short-circuits when the candidate commit equals the release commit,
returning `{ required: false, covered: true, audit: null }` without consulting the audit lines. The gate
therefore emits `PREFLIGHT-CANDIDATE-OK`, the marker `release-dist` looks for is absent, and the byte
difference — which still exists, for Cause 1 — is judged `diff` and refused.

## Reproduction (hermetic, no network, no build)

Method: call `runPreflightGate` with a fake ticket-face adapter, a parsed candidate fixture and a fake
command port, then apply exactly what `release-dist.mts` does (scan the lines for the marker, call
`judgeReleaseBytes`, call `requireCandidateBytes({ push: true })`).

| Situation | Gate exit | Marker | report.audit | Verdict | `--push` |
| --- | --- | --- | --- | --- | --- |
| equal commits, audit line in ticket (the v2.1.1 situation) | 0 | `PREFLIGHT-CANDIDATE-OK` | required false, covered true | `diff` | refused |
| differing commits, same audit shape (control) | 0 | `PREFLIGHT-CANDIDATE-AUDIT` | required true, covered true | `diff-audited` | passes |
| equal commits, no audit line | 0 | `PREFLIGHT-CANDIDATE-OK` | required false, covered true | `diff` | refused |

The first and third rows are identical, which is the plainest statement of the problem: with equal
commits the audit line changes nothing.

## What is not covered by a test

`tests/verify-release-gate.ts` covers the differing-commit audit case and the equal-commit
`PREFLIGHT-CANDIDATE-OK` case separately. `tests/verify-release-dist-gate.ts` only asserts that
`release-dist.mts` mentions the marker string. Nothing connects a checklist-ticket audit line to the
`release-dist` decision, so a later change can break that seam silently.

## Directions considered (not chosen here — this is a diagnosis note)

1. Write the identity banner inside `scripts/build.mts`, so every build agrees and the published
   artifact carries its own identity; `verify/build.mjs`'s patch becomes a no-op.
2. Run the publish build through `verify/build.mjs`, publishing exactly what was verified.
3. Repair the marker path so a documented audit is accepted even when the commits are equal.

Either of 1 or 2 removes the need for an audit on a clean release; 3 is still needed for the acceptance
criterion that a test covers the audit path end to end.

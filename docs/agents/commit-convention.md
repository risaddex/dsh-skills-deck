# Commit message convention

Every `git commit` message is written in English, in complete sentences that say what changed and why it changed.

## Rules

1. **Title**: one complete description, at least ten words long, with the tickets it serves in parentheses at the end of the line: a single ticket as `(#1136)`, several as `(#1057, #1063)`, and a short qualifier when the relation needs saying, as in `(#1052 wrap-up)`. Write a ticket as `#` plus the digits, at the end of the line, in ascending order, separated by commas; never write a bare number without the `#`. Write a pull request as `PR #977` so it never looks like a ticket.
2. **Body**: say what changed and why, and add one sentence about verification — which checks you ran and how they turned out; when you verified nothing, say that plainly.
3. **The ticket number must be real**: read the ticket once before committing, and check that the number and the subject match.
4. **One commit carries one thing that can be delivered on its own**; when a commit serves several tickets at different stages, describe each of them in its own paragraph of the body.
5. **Name the paths you commit yourself**: run `git status` before committing to see which files this task touched, and `git add` only those paths; never use `git commit -a` or `git add -A`. The same working tree may hold uncommitted changes from another session, and sweeping everything in would drag that work into your commit.

## Example

```
Convert issueDetail from JavaScript to TypeScript without changing its behaviour (#1161)

Add the return type annotations at both entry points; the logic is unchanged.
tsc and tests/verify-1053-issue-write pass, and all five smoke runs are green.
```

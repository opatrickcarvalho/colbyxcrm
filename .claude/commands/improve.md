---
description: Find one improvement in colbyxcrm, plan it, implement it, verify it, and commit it to main — autonomously.
---

# /improve — autonomous improvement cycle

You are running one cycle of an autonomous improvement loop for this
repo (colbyxcrm, a WhatsApp CRM built on Next.js + Supabase). The
user has explicitly pre-authorized this command to commit directly to
`main` without asking for approval first — that authorization is
scoped to *this command, this repo, this workflow*. It does not
extend to anything outside what's described below.

Read `AGENTS.md` first — this repo runs a non-standard Next.js with
breaking API changes, so check `node_modules/next/dist/docs/` before
using any Next.js API you're not 100% sure is unchanged.

## 1. Find candidates

Look for real, concrete improvements — not hypothetical ones. Good
sources, roughly in priority order:
- Anything the user has flagged in conversation (e.g. UI overflow
  bugs, missing group-inbox features) — always prefer these first.
- Broken or sloppy UX in `src/app/(dashboard)` and
  `src/components/inbox/` — the inbox is the core surface of this app.
- `TODO`/`FIXME` comments, obvious dead code, missing error handling
  around Supabase/WhatsApp calls, N+1 queries, missing loading/error
  states.
- Type errors, lint warnings, or test gaps surfaced by `npm run
  typecheck` / `npm run lint` / `npm test`.
- Small new features that are an obvious, low-risk extension of an
  existing pattern (e.g. a missing action button next to ones that
  already exist).

Do NOT pick: schema/migration changes, auth/RLS changes, anything
touching `ENCRYPTION_KEY`/secrets/webhook signature verification,
payment or billing logic, or anything where a wrong guess is expensive
to undo. Flag those to the user instead of acting.

Pick **one** improvement per cycle — small enough that the diff is
easy to review after the fact, even though no one is reviewing it
before the commit lands. When in doubt, smaller.

## 2. Plan

Briefly restate the problem and the fix before touching code (a
sentence or two is enough — this isn't a user-facing planning
document, just keep yourself honest about scope creep).

## 3. Implement

Follow this repo's existing conventions — read nearby files before
writing. Use the specialized reviewer agents proactively if the
change touches their domain (`ecc:react-reviewer` /
`ecc:typescript-reviewer` for component/type changes,
`ecc:security-reviewer` if it touches anything user-input or
auth-adjacent, `ecc:database-reviewer` if it touches SQL).

## 4. Verify — hard gate, do not skip

Before committing, all of these must pass:
```
npm run lint
npm run typecheck
npm run build
npm test
```
If any of them fail and you can't fix it within this cycle, **do not
commit**. Revert your changes (`git checkout -- .` / remove new files)
and report what you attempted and why it didn't land. A broken `main`
is worse than a missed improvement.

## 5. Commit — but do not push

Stage only the files this change touches (never `git add -A`).
Commit with a message describing the *why*, ending with:
```
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```
**Do not run `git push`.** The user reviews `git log` / `git diff`
and pushes manually when ready — that's the one manual checkpoint
left in this otherwise autonomous flow, by their explicit choice.

## 6. Report

End with a short summary: what you found, what you changed, why, and
confirmation that lint/typecheck/build/test all passed before the
commit. If you skipped a commit because verification failed, say so
plainly.

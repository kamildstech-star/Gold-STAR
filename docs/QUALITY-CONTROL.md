# Quality control: what checks the code, when, and what it costs

Every automated check on this repository, in one place. The workflow files
under `.github/workflows/` carry the detailed reasoning in their comments; this
page is the map.

## What runs when

| Event                                                                   | Pull request checks                       | Secret scan      | AI review                                                                           |
| ----------------------------------------------------------------------- | ----------------------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| Pull request into `main` (opened, new push, reopened, ready for review) | Yes                                       | Yes              | Yes: summary comment and inline comments (not drafts, not Dependabot)               |
| Lovable (or anyone) pushes straight to `main`                           | Yes                                       | Yes              | Yes, after the checks finish; opens an `ai-review` issue only if it finds a problem |
| A pull request is merged (its push to `main`)                           | Skipped: it was checked as a pull request | Yes              | Skipped                                                                             |
| Monday 09:37 UTC (05:37 New York in summer)                             | Yes, a full check of `main`               | Monday 06:17 UTC | No                                                                                  |
| "Run workflow" on the Actions tab                                       | Yes, on the branch you pick               | No               | No                                                                                  |
| A comment containing `@claude` from the owner or a collaborator         | No                                        | No               | Yes: answers, or commits the requested fix                                          |

Changes that touch only Markdown, `docs/`, `.claude/` or `LICENSE` skip the
checks and the AI review: they cannot change what the code does.

How a push to `main` is recognised as a merged pull request: GitHub itself
commits the merge (as `noreply@github.com`) and titles it either
`<title> (#123)` (squash merge) or `Merge pull request #123 from ...` (merge
commit). Lovable's commits are committed by `gpt-engineer-app[bot]`, so they
are always checked. A rebase merge carries neither title and is checked once
more, which costs minutes but is never unsafe.

## What blocks and what only advises

"Blocks" means the check goes red. On a pull request a red check is a reason
not to merge (and blocks the merge button if the check is made required in
branch protection). On `main`, after a Lovable push, red means "main is broken
or has a new problem; look now".

Pull request checks (`.github/workflows/pull-request-checks.yml`), one job:

| Step                                  | Blocks? | Notes                                                                                    |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `npm audit --audit-level=high`        | Blocks  | High and critical advisories only                                                        |
| Semgrep, ERROR severity               | Blocks  | Static security scan of `src/` and `scripts/`, see below                                 |
| Semgrep, WARNING severity             | Advises | Shown as yellow annotations on the lines                                                 |
| Lint of changed `.ts`/`.tsx` files    | Blocks  | ESLint errors only; warnings do not block                                                |
| `tsc --noEmit`                        | Blocks  |                                                                                          |
| Vitest                                | Blocks  |                                                                                          |
| PostgreSQL security fixtures (PGlite) | Blocks  |                                                                                          |
| `build:vercel` and `build`            | Blocks  |                                                                                          |
| Lint of the whole repository          | Advises | The pre-existing backlog, almost all Prettier formatting in the generated Supabase types |

Secret scan (`secret-scan.yml`, gitleaks) blocks. CodeQL (`codeql.yml`) is
switched off because code scanning needs GitHub Advanced Security on a private
repository; Semgrep covers that gap. The AI review never blocks: it comments
and opens issues.

### Lint of changed files

A file a change touches has to be lint-clean. That is how the backlog shrinks
instead of growing. Deleted files are ignored, a renamed file is linted under
its new name, and a change with no TypeScript skips the step. The generated
`src/integrations/supabase/types.ts` and `src/routeTree.gen.ts` are never
linted.

Prettier formatting counts on pull requests (run `npx prettier --write <files>`
before pushing). It is switched off for Lovable's direct pushes, because Lovable
does not run Prettier and a red check on `main` for indentation would teach
everyone to ignore red checks.

### Semgrep

[Semgrep Community Edition](https://semgrep.dev/docs/getting-started/quickstart-ce)
runs the free registry rulesets `p/typescript`, `p/react`, `p/nodejsscan` and
`p/secrets`. No account, no token; `--metrics=off` sends nothing back.
`.semgrepignore` leaves out tests, test fixtures and generated files.

- On a pull request or a push it scans only the files changed since the base
  commit and reports only findings the change introduced. A finding that was
  already there never blocks someone else's change.
- The weekly run scans everything; that is where pre-existing findings show.
- A false positive is silenced on the line above it, with the reason in a
  comment:

  ```ts
  // The value is a public date, not a credential.
  // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
  export const SECRET_TRANSFER_EXPIRES_AT = "2026-10-25T00:00:00Z";
  ```

  The rule id is in the annotation title and the job log. Only silence a
  finding you have checked; a real problem gets fixed.

To run it on your machine: `pip install semgrep==1.180.0`, then
`semgrep scan --config p/typescript --config p/react --config p/nodejsscan --config p/secrets --metrics=off src scripts`.
On Windows a full scan takes about ten minutes and some rules time out on large
files; on the Linux CI runner it is much faster.

## AI review

`.github/workflows/ai-review.yml`, using Anthropic's official
[`claude-code-action`](https://github.com/anthropics/claude-code-action),
pinned to a released version. It is billed per use to an Anthropic API key;
there is no subscription.

### One-time setup (the owner)

1. Create an API key in the Anthropic Console (<https://console.anthropic.com>,
   API keys). A monthly spend limit on the Anthropic account, also set in the
   Console, is a sensible cap on the bill.
2. In GitHub: the repository, **Settings → Secrets and variables → Actions →
   New repository secret**. Name `ANTHROPIC_API_KEY`, value the key. Save.

That is all. Nothing else needs installing: the workflow uses its own
`GITHUB_TOKEN`, not the Claude GitHub App. Until the secret exists, every AI
review job stops after its first step with a notice "AI review skipped"
instead of failing.

### What it does

- **Pull requests.** Reads the diff, posts one summary comment beginning
  "**AI review**" (it says "No blocking issues" when it finds none) and an
  inline comment on each problem, with a one-click suggestion when the fix is
  small. It looks for security holes (RLS bypass, missing auth or rate limits,
  injection, secrets, SSRF), double sends, data loss, crashes, wrong money
  maths and changed logic with no test. It does not repeat what CI already
  checks (types, lint, formatting).
- **Lovable's direct pushes.** Reviews the pushed diff after the checks finish.
  Silent when it finds nothing (the run's summary page says "No blocking
  issues"); otherwise it opens one GitHub issue labelled `ai-review` with the
  findings.
- **`@claude` on request.** In a comment on a pull request, a review comment or
  an issue, from the owner or a collaborator:

  ```
  @claude fix the null check this review flagged in job-billing-panel.tsx
  @claude why does this migration need SECURITY DEFINER?
  @claude fix the failing unit test
  ```

  On an open pull request a fix is committed to that pull request's branch,
  and the pull request checks are then started on it automatically. On an
  issue (including an `ai-review` issue) the fix goes to a new `claude/...`
  branch and Claude replies with a link to open the pull request; the pull
  request is yours to open, review and merge.

### What it can never do

- Merge, approve or request changes. None of its tools can.
- Push to `main`. The review jobs have read-only access to the code; fixes are
  committed through the action's API commit tool, which writes only to the
  branch the action prepared (the pull request's branch or a new `claude/...`
  branch).
- Change workflows or read secrets. It runs on the workflow's `GITHUB_TOKEN`,
  which GitHub never allows to modify `.github/workflows/`.

### Settings

Repository variables (Settings → Secrets and variables → Actions → Variables):

| Variable                      | Effect                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `AI_REVIEW_MODEL`             | Model to use. Default `claude-opus-5-5`; `claude-sonnet-5-5` costs half as much per token      |
| `AI_REVIEW_ON_SYNC` = `false` | Review a pull request when it is opened, reopened or marked ready, but not on every later push |
| `AI_REVIEW_DISABLED` = `true` | Switch all AI review jobs off without starting a runner                                        |

## Cost

Estimates from the last 30 days on `main`: about 190 merged pull requests and
about 20 direct Lovable commits. A pull request checks run takes about ten
billed minutes. Actions minutes are counted against the account's monthly
allowance; beyond it they are billed (Linux runners, at GitHub's per-minute
rate).

| Piece                                 | Actions minutes                                                                    | API cost                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Pull request checks, per run          | about 10-12 (Semgrep and the changed-file lint add about 1-2 to the previous 9-10) | none                                                                                                          |
| Checks on Lovable's direct pushes     | about 10-12 each; about 20 a month, so about 220 a month                           | none                                                                                                          |
| Weekly full check                     | about 12-15 each; about 60 a month                                                 | none                                                                                                          |
| AI review of a pull request, per run  | about 3-6                                                                          | typically US$0.30-1.50 on Opus 5.5 (US$4 / US$20 per million input / output tokens); about half on Sonnet 5.5 |
| AI review of a Lovable push           | about 3-6                                                                          | similar, usually smaller diffs                                                                                |
| `@claude` request                     | about 3-10                                                                         | US$0.50-3 for a fix, depending on size                                                                        |
| AI review while the secret is not set | 1 per trigger (a few seconds, billed as a minute)                                  | none                                                                                                          |

The AI review runs on every push to every pull request by default. With about
190 pull requests a month and often more than one push each, that is the
largest new cost: on the order of 300 reviews, 1,000-1,800 Actions minutes and
US$100-400 of API use a month on Opus 5.5. Setting `AI_REVIEW_ON_SYNC=false`
cuts the review count to roughly one per pull request; switching to Sonnet 5.5
halves the API cost again. Each run is also capped by `--max-turns` and a job
timeout, and a new push cancels the review of the previous one.

## Turning pieces off

| To stop                                   | Do                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All AI review                             | Set the repository variable `AI_REVIEW_DISABLED` to `true` (or delete the `ANTHROPIC_API_KEY` secret, which still starts a one-minute job per trigger) |
| AI review on every push to a pull request | Set `AI_REVIEW_ON_SYNC` to `false`                                                                                                                     |
| Checks on Lovable's direct pushes         | Delete the `push:` block in `pull-request-checks.yml`                                                                                                  |
| The weekly check                          | Delete the `schedule:` block in `pull-request-checks.yml`                                                                                              |
| Semgrep                                   | Delete the two Semgrep steps in `pull-request-checks.yml`                                                                                              |
| Changed-file lint blocking                | Add `continue-on-error: true` to the "Lint changed TypeScript files" step                                                                              |
| Any workflow, temporarily                 | Actions tab, the workflow, "..." menu, **Disable workflow**                                                                                            |

Do not change branch protection to work around a red check; fix the cause, or
silence a verified false positive at the line.

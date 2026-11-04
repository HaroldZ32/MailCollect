# AGENT.md

Operating instructions for any AI agent working in this repository.

## 1. Read first

- `docs/requirements.md` — requirements and the measurable acceptance criteria.
- `.mpd/plans/001-mvp.md` — architecture, data flow and the FROZEN contracts.
- `packages/shared/src/{domain,extraction,api}.ts` — the contracts themselves.
- Prefer this repository's own docs and tests over assumptions. When a document and
  the code disagree, report the conflict instead of silently picking one.

## 2. Plan before acting

- State the goal in one sentence, then list the steps you will take.
- Keep a todo list for any task with two or more steps, and update it as steps finish.
- Surface open questions and assumptions before making a large change.

## 3. Small diffs

- Make the smallest change that satisfies the request; no drive-by refactors and no
  reformatting of code you did not need to touch.
- Match the style, naming and structure already in the tree.
- One lane per directory. Never edit another lane's files; report the finding instead.

## 4. Commands

Run from the repository root.

- Install dependencies: `npm install`
- Dev (UI only, browser): `npm run dev`
- Dev (API server only): `npm run dev:server`
- Dev (full desktop app): `npm run dev:desktop`
- Build: `npm run build`
- Test: `npm test`
- Type check: `npm run typecheck`
- Single package: `npm run typecheck -w @mailcollect/core` (same shape for `test` / `build`)
- Integration smoke: `npm run smoke` — boots the real server on a random port with a
  throwaway data dir and checks the HTTP contract end to end.
- UI screenshots: `SHOT_ROUTES="/,/tasks,/timeline,/settings" node scripts/shot.mjs`
  (Playwright headless Chromium; writes into `evidence/ui/`).
- Format: none configured yet — match the surrounding style by hand.

Environment notes for this machine: `NODE_ENV=production` is set globally, so a manual
npm install MUST pass `--include=dev` (`.npmrc` pins `include=dev` for this project).
`$HOME` and pnpm's store lock are read-only under the sandbox — redirect `HOME`,
`XDG_CACHE_HOME` and `npm_config_cache` into the workspace before running package
managers, and use npm rather than pnpm for installing.

`pnpm` is also wired (`pnpm-workspace.yaml` sets `verifyDepsBeforeRun: false`), but npm
is the source of truth: `package-lock.json` is authoritative.

## 5. Verification

- Re-run the checks that cover your change and quote the observed output.
- Never edit a test or a gate to make a change pass; fix the cause or report the defect.
- A change written by one agent is verified by a DIFFERENT agent from the frozen
  contract, never from the author's reasoning.

## 6. Git discipline

- Work on a branch, never directly on the main branch.
- Use a commit format such as `<type>(<scope>): <summary>`.
- Open a pull request describing what changed, the evidence, the checks run and any
  unverified bound.
- One writer per working tree; never rewrite published history.

## 7. Architecture invariants

- `shared ← core ← server ← desktop`, and `ui → shared(types only)`. No reverse edges.
- The UI talks to the service over HTTP/SSE only. There is no second transport.
- No native modules: SQLite goes through Node's built-in `node:sqlite`, so the same
  code runs in Electron and in a plain `node` server.
- Secrets are AES-256-GCM encrypted at rest (`packages/core/src/store/crypto.ts`) and
  must never appear in logs, API responses or error messages.
- Every write appends to `change_log`; that table is the reserved cloud-sync seam.

## 8. Security

- Never commit or echo secrets, tokens or credentials.
- Keep generated logs and evidence free of secret material.

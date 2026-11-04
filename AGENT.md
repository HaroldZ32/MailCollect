<!-- Generated once by mpd-project-init (my-power-dsh) on 2026-11-04T02:11:40.993Z.
     This file is a starting point: edit it freely. The plugin never overwrites it,
     and it will not create another instruction file in this workspace. -->

# AGENT.md

Operating instructions for any AI agent working in this repository. Replace every
`<fill in: ...>` placeholder with this project's real value; never guess one.

## 1. Read first

- At the start of every session, read this file, then the paths it names below.
- Prefer this repository's own docs, tests and build files over assumptions. When a
  document and the code disagree, report the conflict instead of silently picking one.

## 2. Plan before acting

- State the goal in one sentence, then list the steps you will take.
- Keep a todo list for any task with two or more steps, and update it as steps finish.
- Surface open questions and assumptions before making a large change.

## 3. Small diffs

- Make the smallest change that satisfies the request; no drive-by refactors and no
  reformatting of code you did not need to touch.
- Match the style, naming and structure already in the tree.

## 4. Commands

Fill in the real commands for this project:

- Install dependencies: `<fill in: e.g. bun install>`
- Build: `<fill in: the build command>`
- Test: `<fill in: the test command>`
- Type check and lint: `<fill in: the typecheck/lint command>`
- Format: `<fill in: the formatter command>`

## 5. Verification

- Re-run the checks that cover your change and quote the observed output.
- Never edit a test or a gate to make a change pass; fix the cause or report the defect.

## 6. Git discipline

- Work on a branch, never directly on the main branch.
- Use a commit format such as `<type>(<scope>): <summary>`.
- Open a pull request describing what changed, the evidence, the checks run and any
  unverified bound.
- One writer per working tree; never rewrite published history.

## 7. Delegation and evidence

- Split large work into bounded tasks with a written contract and a separate review.
- Keep requirement, implementation and review as separate records.
- Record evidence (command, observed result, path) on disk; a claim without evidence is
  incomplete.

## 8. Security

- Never commit or echo secrets, tokens or credentials.
- Keep generated logs and evidence free of secret material.

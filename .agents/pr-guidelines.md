# PR Guidelines — Obsidian Google Docs Sync

Generated from the repository's existing scripts, CI workflow, README test plan,
and comparable Obsidian plugin projects. Edit this file as the project evolves.

## Commands

| Task | Command |
|---|---|
| Type-check | `npx tsc --noEmit` |
| Unit and integration tests | `npm test` |
| Production build | `npm run build` |
| E2E tests | `N/A — no automated Obsidian E2E harness` |
| Screenshots | `N/A — no screenshot harness` |

Run the commands from the repository root with the lockfile-supported Node/npm
toolchain. A task is not complete if a command exits non-zero or terminates before
running its checks.

## Coverage Requirements

- All existing tests must pass.
- Every changed behavior needs a focused regression test covering the happy path
  and at least one relevant error or boundary case.
- API tests must mock the Obsidian networking boundary (`requestUrl`) rather than
  making live Google or auth-proxy requests.
- Converter changes must cover representative Markdown/Google Docs payloads and
  preserve round-trip behavior where applicable.
- Sync-engine changes must cover conflict direction, metadata/revision handling,
  and failure recovery relevant to the change.
- No numeric coverage threshold is currently enforced; meaningful behavioral
  coverage is required.

## Obsidian and Network Compatibility Gates

This plugin runs inside Obsidian's Electron renderer. For any authentication,
Google Docs, Google Tasks, export, or other remote-request change:

- Use Obsidian's supported network API (`requestUrl`) for external HTTP requests;
  do not introduce renderer `fetch`, `XMLHttpRequest`, or Axios calls.
- Preserve handling for non-2xx responses, OAuth/token failures, rate limits,
  `Retry-After`, scope errors, and useful user-facing error messages.
- After `npm run build`, inspect `main.js` and confirm the changed remote-request
  path does not contain forbidden renderer network calls. A textual match inside
  a dependency or unrelated dead code must be investigated, not ignored.
- Never use live OAuth credentials, access tokens, refresh tokens, document IDs,
  or personal document contents in committed tests or fixtures.

## Manual Plugin Verification

There is no automated Obsidian E2E harness, so changes that affect runtime plugin
behavior require a desktop smoke test in a disposable/test vault with the
production build installed.

For sync, authentication, or Google API changes, exercise every affected flow:

1. Load the plugin without console errors.
2. Connect or refresh a Google account when authentication code changed.
3. Create or link a disposable note and Google Doc.
4. Sync Obsidian to Google Docs and confirm the remote document content.
5. Sync Google Docs to Obsidian and confirm the local note content.
6. Exercise Google Tasks behavior when Tasks code changed.
7. Inspect Obsidian DevTools for CSP/CORS errors, unhandled rejections, token
   leakage, or unexpected retry loops.

If credentials or a safe test vault are unavailable, report the applicable step
as `NOT VERIFIED`; unit tests and a build are not substitutes for this runtime
check.

## Visual Verification

Skip visual verification when no UI or CSS files changed.

When settings, notices, modals, commands, or CSS change, verify in current
Obsidian desktop at a normal desktop window size and a narrow window width:

- Layout has no clipping, overflow, collapsed sections, or misalignment.
- Interactive controls are reachable, keyboard-usable, and show correct states.
- Light and dark themes remain readable.
- Loading, empty, success, and error states touched by the change are legible.

Record the observed checks in the required vault QA report. Because this project
has no screenshot harness, attach manual screenshots for UI changes.

## Documentation

User-facing documentation lives in `README.md`.

- Review the setup, OAuth, usage, testing, troubleshooting, and architecture
  sections relevant to the change.
- Update documentation whenever commands, settings, permissions/scopes, sync
  behavior, limitations, or recovery steps change.
- Pure internal refactors do not require a README edit, but the review must still
  be recorded.

## Release and Issue Hygiene

- Do not commit secrets, `.env` files, personal document data, or OAuth artifacts.
- Do not bump `package.json`, `manifest.json`, or `versions.json` for an ordinary
  fix PR unless a release is explicitly requested.
- Do not commit generated `main.js` unless the repository's current release
  workflow or maintainer request requires it.
- Reference the GitHub issue in the PR and describe the user-visible failure,
  root cause, fix, tests, build result, and manual verification status.
- Do not merge, publish a GitHub release, or submit to the Obsidian community
  plugin registry without explicit approval.

## Required QA Record

When tests, builds, manual runtime checks, or visual verification are performed,
write a QA report to:

`Products/Obsidian Google Docs Sync/Runs/obsidian-gdocs-sync-YYYY-MM-DD-qa.md`

The report must include exact commands, exit status, observed test counts, build
artifact checks, manual steps and outcomes, screenshots for UI changes, and every
`NOT VERIFIED` item. Link the report from that day's daily note under
`## Claude Sessions`.

## Final PR Checklist

- [ ] `npx tsc --noEmit` passes.
- [ ] `npm test` passes, including focused regression coverage.
- [ ] `npm run build` succeeds and produces a non-empty `main.js`.
- [ ] Network compatibility gates pass when remote-request code changed.
- [ ] Applicable manual Obsidian flows are verified or clearly marked
      `NOT VERIFIED` with the reason.
- [ ] Visual verification and screenshots are complete when UI changed.
- [ ] `README.md` was reviewed and updated if behavior changed.
- [ ] QA report exists and is linked from the daily note.
- [ ] No secrets, personal data, unintended build artifacts, or version bumps are
      present in the diff.
- [ ] GitHub issue is referenced and the PR explains why the change is needed.
- [ ] End-to-end verification of every requirement is complete.

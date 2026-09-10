# Disposable managed-vault QA

This is an acceptance harness, not a user beta or production release. Standard `npm run build` compiles the managed-provider gate to false and excludes the provider. Do not install an acceptance build into a personal vault.

Build the actual plugin plus gated provider into an explicitly chosen temporary directory:

```sh
GEODE_QA_OUTPUT=/absolute/disposable/output node tests/live/build-qa.mjs
```

Install that output with this repository's manifest and stylesheet only in an isolated Geode process, synthetic vault, and separate user-data profile. The QA entry stops the existing Docs and Tasks engines. Its Connect button stores the authorization start URL in memory (`qaAuthUrl`) rather than invoking the operating system. The driver must consume that URL without printing it, open a dedicated browser context, and install `installOAuthCapture` before navigation. The returned state must match the start URL's original state; deliver captured parameters directly to that isolated plugin's `auth.handleCallback`. Never use existing user-profile credentials or change default protocol registration.

The capture helper fetches the upstream callback with redirects disabled, validates the Geode destination and OAuth state, and replaces the token-bearing redirect with a clean completion redirect. It never renders the upstream success page or launches `geode://`. Browser tracing, HAR recording, screenshots during sign-in, verbose request logging, and raw error printing must remain disabled. Account selection and Google consent require explicit user authorization. Each client authenticates independently to the same chosen account and OAuth app.

Synthetic proof, with a caller-supplied installed Playwright module:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/@playwright/test node tests/live/oauth-capture-smoke.mjs
```

This launches normal system Chrome on macOS with a new temporary profile and an explicit loopback debugging port, then attaches with Playwright CDP. It uses no automation or stealth flags. The local synthetic proxy verifies callback delivery and checks browser history/address/console for token URL exposure. It also checks the browser's automation indicator and confirms its own Chrome process closes and temporary profile is removed. It makes no Google requests. This proves callback capture, not Google sign-in acceptance.

After explicit user approval of the disposable account, the live driver can open one isolated client:

```sh
GEODE_QA_CORE=/absolute/core/worktree GEODE_QA_OUTPUT=/absolute/disposable/output node tests/live/run-isolated.mjs --authorize-disposable-account
```

This driver is not yet live-verified. It launches Geode with `GEODE_HEADLESS=1` to suppress global protocol registration and single-instance routing, then explicitly shows only its own window. Click Connect there to open normal Chrome with a disposable profile for manual sign-in. Callback interception is installed before sign-in navigation. The driver creates no remote roots and starts no sync. A private fixture manifest records local client profile paths; retain it and record every explicitly created disposable remote root for later user-directed cleanup. Close the isolated client or interrupt the driver to close only its own processes and remove its temporary Chrome profile. Repeat independently for each client; do not copy credentials between profiles.

Ordinary Obsidian regression acceptance remains separate: prove its profile/vault isolation first, then verify Connect/refresh/reconnect, disposable Google Docs push and pull, and Google Tasks behavior. The current capture helper intentionally accepts only `geode://`; do not use it for an Obsidian callback without an explicit, tested allowlist extension. Never let either test flow launch the user's installed protocol handler.

Disk amplification benchmark (mock Drive, real atomic filesystem writes):

```sh
DRIVE_JOURNAL_BENCH_COUNT=10000 npm test -- tests/sync/GoogleDriveHistory.test.ts -t disk-backed
```

This measures journal bytes and upload/append/read operations, not live Drive performance or the host's fsync latency. Temporary test directories are removed after each test.

Still required before beta activation: real two-client offline/concurrent edits, rename/delete/edit conflicts, cancellation and interrupted upload recovery, third-client reconstruction, actual large-file host transport, 10,000-file request counts and timing, and a 24-hour soak. Live fixtures must use an explicitly named disposable managed root and synthetic content only. There is no remote garbage collection or automatic cleanup. Preserve a private fixture manifest for user-directed cleanup after acceptance.

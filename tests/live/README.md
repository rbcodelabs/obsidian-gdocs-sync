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

This launches isolated headless Chrome and a local synthetic proxy, verifies callback delivery, and checks browser history/address/console for token URL exposure. It makes no Google requests. The fixture closes only its own browser and server.

Disk amplification benchmark (mock Drive, real atomic filesystem writes):

```sh
DRIVE_JOURNAL_BENCH_COUNT=10000 npm test -- tests/sync/GoogleDriveHistory.test.ts -t disk-backed
```

This measures journal bytes and upload/append/read operations, not live Drive performance or the host's fsync latency. Temporary test directories are removed after each test.

Still required before beta activation: real two-client offline/concurrent edits, rename/delete/edit conflicts, cancellation and interrupted upload recovery, third-client reconstruction, actual large-file host transport, 10,000-file request counts and timing, and a 24-hour soak. Live fixtures must use an explicitly named disposable managed root and synthetic content only. There is no remote garbage collection or automatic cleanup. Preserve a private fixture manifest for user-directed cleanup after acceptance.

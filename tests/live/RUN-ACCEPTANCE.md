# Direct operator acceptance command

This test-only CLI wires the three isolated Electron clients, safe independent browser sign-ins, staged runner, and owned-process recovery hooks. It requires no operator JavaScript. It has **not been run with real Google authorization**. Passing its fake checks does not establish live acceptance.

Build the matching Geode desktop app and the separate plugin QA bundle first (see `README.md`). Choose one disposable Google account and a unique synthetic remote name. Never use a personal vault or existing Geode profile. The fixture directory must not exist for the first invocation; the CLI creates it privately. Paths below are placeholders that the operator must replace.

```sh
node tests/live/run-acceptance.mjs \
  --authorize-disposable-account --authorize-remote-writes \
  --root qa-unique-disposable-run \
  --fixture /absolute/private/new-fixture \
  --core /absolute/built-geode-worktree \
  --bundle /absolute/separate-qa-bundle \
  --stage primitives
```

Click Connect in each numbered test window, then authorize the selected disposable account in its separate browser session. Credentials remain in each isolated profile; they are not copied between clients. The redirect is intercepted before the token-bearing URI reaches browser history or the OS protocol handler. No tracing, HAR, request logging, or auth screenshots are enabled. Each sign-in has a ten-minute timeout. Resume uses credentials only from those same explicitly created profiles.

Repeat the same command with `--resume` and the next stage: `clients`, `rename-delete-edit`, `portable-config`, `large-file`, `interrupted-transfer`, `scale`, then `soak`. Each command executes only its explicitly named stage; profiles are closed afterward. Failed/interrupted stages additionally require `--retry` after inspecting their isolated state. The same fixture/root/core identity is required on resume. No remote root is adopted by name after interrupted setup; an unpinned root requires separate explicit inspection.

The launch receipt pins both repositories' source commit IDs and SHA-256 digests of the actual core `dist` tree and QA bundle. Resume refuses changed sources/build bytes even at the same paths; use a new fixture for a new build. Before any stage, all three independently authorized providers must return the same stable Drive account fingerprint. Only a one-way hash is stored privately; raw account IDs and tokens never leave the renderer or enter diagnostics. Resume also refuses a changed account fingerprint.

Exit codes are explicit: `0` passed, `1` failed/invalid launch, `2` pending (including an unfinished soak), and `3` not verified. Neither an unfinished nor unverified gate reports a successful process exit.

`large-file` transfers a 100 MiB binary. `scale` creates 10,000 files. The two authorization flags include permission for the named stage's synthetic remote writes; do not invoke these expensive stages without the account owner's approval. `interrupted-transfer` intentionally kills **only** a validated test Electron child during an observed upload chunk and relaunches the same private profile. The soak hook performs one observed offline-request rejection plus owned-process restart, then reuses that evidence—not continuous offline coverage.

Invoke `soak --resume` hourly using the same full flags and paths. The command performs one tick and exits; it does not schedule itself. Passing requires at least 25 ticks over 24 hours, no gap above 90 minutes, verified expected bytes on all clients, and the successful offline/restart hook. Missing ticks or hook failures are not a pass. See `LIVE-ACCEPTANCE.md` and `LIVE-HOOKS.md` for exact evidence semantics.

The CLI never deletes fixture data, credentials, journals, or remote objects automatically. Private `acceptance-launch.json`, `live-acceptance.json`, and `live-hooks.json` remain for resume and later user-directed cleanup. SIGINT/SIGTERM closes only handles launched by this command. Failure messages are deliberately fixed and redact sensitive diagnostics.

Still separate: ordinary Obsidian Docs/Tasks runtime compatibility, credential-refresh/reconnect matrices, full portable-settings conflicts, and actual live results. There is no aggregate beta-ready flag.

Offline checks only:

```sh
node --test tests/live/*.checks.mjs
node --check tests/live/run-acceptance.mjs
```

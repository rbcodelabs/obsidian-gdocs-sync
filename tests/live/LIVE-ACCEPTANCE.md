# Staged managed-history acceptance runner

This runner is acceptance-only. It neither authorizes accounts nor launches an app/browser, reads tokens, changes protocol handlers, or deletes remote data. Do not invoke it against user vaults. Passing its synthetic orchestration tests is **not** live Drive acceptance.

An operator must explicitly authorize the disposable account and remote writes, then supply three separately authorized, isolated Geode Playwright pages. Each page needs the QA plugin build exposing `qaProvider`, a distinct synthetic vault beneath one private fixture directory (0700), and a separate user-data profile. The runner validates distinct pages/vaults, not the underlying profile or account; the operator must verify those. Disable HAR/tracing, sign-in screenshots, and request/console diagnostics.

```js
import { createLiveAcceptance } from './tests/live/live-acceptance.mjs';
const acceptance = await createLiveAcceptance({
  pages: [authorizedPageA, authorizedPageB, authorizedPageC],
  pluginId: installedQaPluginId,
  fixtureDirectory: explicitPrivateFixtureDirectory,
  rootName: 'qa-disposable-unique-run-name',
});
await acceptance.runStage('primitives');
await acceptance.runStage('clients');
await acceptance.runStage('rename-delete-edit');
await acceptance.runStage('portable-config');
await acceptance.runStage('large-file');
await acceptance.runStage('interrupted-transfer');
await acceptance.runStage('scale');
// Invoke periodically from the operator's scheduler; this call does not sleep.
await acceptance.runStage('soak');
```

There is deliberately no command-line auto-execution or authorization switch. Construction only validates local isolation. Each `runStage` is an explicit mutation boundary. Keep the unique root name and private `live-acceptance.json` for later user-directed remote cleanup; exact remote descriptor IDs/UUIDs are pinned there before transfer. The primitive stage creates an additional root with `-primitive` suffix. An existing root cannot be adopted by name; an unpinned root requires separate explicit operator inspection/adoption. Concurrent runner processes for one fixture are unsupported.

## Executable stages

- **primitives:** actual provider create replay, frozen blob replay after discarding the initial response, verified read hash, already-aborted operation rejection, duplicate record append, full-scan identity verification. IDs are persisted before remote calls. This simulates a lost caller response, not an actual network disconnect during upload.
- **clients:** actual host `activate/create/join/preview/run`, identical initial reconstruction, both clients paused while synthetic divergent edits are made, preserved concurrent branches, explicit displayed-version resolution, and fresh third-client reconstruction after resolution with matching hashes and zero conflicts. Only synthetic content files participate; portable configuration is disabled for this stage.
- **rename-delete-edit:** synthetic rename/edit and delete/edit branches while two clients are paused; all three clients must retain both conflicts. It then resolves displayed versions and verifies identical valid paths/bytes and zero remaining conflicts before later recovery stages.
- **portable-config:** a logical editor setting changed through public `vault.setConfig`, verified in persisted and runtime settings on three clients. This covers editor settings, not the complete appearance/hotkeys/daily-notes matrix.
- **large-file:** an exactly 100 MiB synthetic binary travels through actual host writes and sync; size and SHA-256 must agree on all clients. This is explicitly expensive and requires operator approval.
- **interrupted-transfer:** requires caller-supplied `hooks.interruptedTransfer({pages, pluginId, fixtureDirectory, rootName})`. That operator hook must inject a real transfer interruption, restart only the isolated independently authorized client, recover it, and return `{verified:true, hashes:[verifiedSha256], bytes:verifiedByteCount}`. Missing/negative proof persists `not-verified`; the runner never substitutes an ordinary replay for this gate. Hook orchestration itself remains operator implementation, not an implemented live test here.
- **scale:** 10,000 separate `bench-*.md` files, sequential actual host sync on three clients, matching byte hashes, aggregate hash, elapsed time and counted host network requests. This can take substantial time and consume Drive quota; invoke only with explicit load-test approval. Background polling can add requests to the observed count; this is an end-to-end count, not a transport microbenchmark.
- **soak:** one new synthetic file per invocation and verified three-client reconstruction. Passing requires at least 25 ticks spanning 24 hours, no inter-tick gap over 90 minutes, and `hooks.soakEvidence()` returning `{offlineRestartVerified:true}` after the operator has actually exercised and verified offline/restart recovery. Missing evidence or excessive gaps persist `not-verified`; two ticks separated by 24 hours cannot pass. Schedule hourly; the runner never sleeps or launches a scheduler itself.

Failed/interrupted stages require `runStage(name, {retry:true})`. Frozen primitive IDs permit safe replay. Client setup is not silently undone: if a failed client stage already bound a page, the operator must inspect that isolated binding before retry; this runner does not disconnect or discard recovery automatically. Successful stages are not rerun, except soak ticks. Private manifest writes are flushed atomically and contain only synthetic names/IDs, hashes, counts, timing and status; arbitrary renderer errors/diagnostics are not persisted.

Byte checks compare against independently computed synthetic source hashes, not merely agreement between clients. Soak also requires exactly one expected file per completed tick. Every sync rejects pending dependencies, blocked/excluded paths, and unhealthy status; only the explicitly exercised conflict paths are allowed during conflict scenarios. Conflicts must be resolved before subsequent stages.

## Remaining operator acceptance

This scaffold does **not** establish real account authorization, real interruption-hook implementation, credential refresh/reconnect, complete portable-settings/conflict coverage, or ordinary Obsidian Docs/Tasks compatibility. Those remain separate required procedures. Executable matrix/large-file steps are unverified on Drive until an authorized operator runs them. No live stage was run while preparing this runner; there is no overall beta-pass flag.

Offline safety/orchestration check (no browser or network):

```sh
node --test tests/live/live-acceptance.checks.mjs
node --check tests/live/live-acceptance.mjs
```

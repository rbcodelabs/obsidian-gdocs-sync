# Owned-process recovery hooks

`live-hooks.mjs` supplies executable `interruptedTransfer` and `soakEvidence` hooks for the staged runner. It does not launch authorization, read/copy credentials, create remote roots, alter global networking, or kill processes by name/PID search. No live run has been performed while developing these hooks.

After the clients stage has established and resolved the shared fixture, supply its pinned descriptor from the private acceptance manifest and three already-authorized isolated Electron handles:

```js
const hookTargets = {}; // Supply this same mutable object to createLiveAcceptance.
const acceptance = await createLiveAcceptance({ pages, pluginId, fixtureDirectory,
  rootName, hooks: hookTargets });
await acceptance.runStage('clients');
const pinned = JSON.parse(await readFile(acceptance.manifestPath, 'utf8')).bindings.shared;
Object.assign(hookTargets, await createLiveHooks({
  clients, // [{electronApp, page, relaunch}, ...] — exactly three owned clients
  pages,   // The SAME mutable array supplied to the runner
  pluginId, fixtureDirectory, binding: pinned,
}));
await acceptance.runStage('interrupted-transfer');
await acceptance.runStage('soak');
```

Each supplied `relaunch()` must launch **only its own original isolated profile/vault**, wait for layout/plugin readiness, and return `{electronApp, page}`. It must not reauthorize or copy credentials. The hook checks the new PID, changed page handle, unchanged root spelling, canonical root, private profile, and pinned binding before replacing `clients[index]` and `pages[index]`. Separate canonical vaults, profiles, and PIDs are mandatory. The fixture directory must be 0700; the supplied main PID must match `electronApp.process().pid`. Never pass a real user app or vault.

## What verification actually means

- Interruption creates a deterministic 16 MiB binary through the host. A temporary renderer `host.network.request` wrapper observes an actual dispatched PUT with a numeric `Content-Range` chunk (not a status probe). It exposes only started/settled booleans, not URLs, headers, content, or resumable capabilities. The request must still be unsettled after the phase receipt is persisted. Then only the verified supplied `ChildProcess` receives `SIGKILL`, and its exit is awaited before relaunch.
- Recovery must occur automatically at startup. The hook does not preview or abandon a pending batch to obtain a passing result. It waits for idle plus the expected file size/SHA-256, then syncs the two other independent clients and verifies the same bytes there. A locally present file alone cannot pass.
- Offline verification rejects requests through the test-only **host** network wrapper, makes a synthetic offline edit, observes an actual rejected request, kills/relaunches the owned process, and requires the same three-client recovery. Browser-context offline mode is not used because it does not cover main-process HTTP.
- `soakEvidence()` performs this offline/restart exercise once. Subsequent calls return the persisted verified result. This is **one offline/restart event**, not repeated failure coverage at every soak tick. `{exercise:false}` reads the result without running it; an unexercised hook returns false.

Run hooks only with a healthy, approved binding and no unresolved conflicts/blocked paths. The runner's matrix stage must resolve its synthetic conflicts before later idle-required gates. If requests complete too quickly to observe an unsettled chunk, the hook fails rather than claiming interruption. No automatic repeated destructive retry occurs.

## Failure and retained evidence

`live-hooks.json` is atomically flushed in the private fixture directory. It stores synthetic operation identity, a fixture-identity hash, phase/verification flags, byte counts and hashes—not request data or raw errors. Failed hooks throw a fixed redacted message. They restore only their own wrapper on a surviving, reverified page. They never delete recovery data or remote objects.

If relaunch or verification fails, inspect only the isolated fixture and retain both manifests; a failed attempt may have left the owned process stopped or the binding paused. The operator must reconcile that state before retry. A callback returning the original PID/page cannot count as restart.

Offline checks (fake page/process handles; no real process kills, browser, auth, or network):

```sh
node --test tests/live/live-hooks.checks.mjs
node --check tests/live/live-hooks.mjs
```

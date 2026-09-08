import { readFile, open, rename, realpath, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const seedHashes = count => Array.from({ length: count }, (_, index) => digest(`Synthetic fixture ${index} 0`));
function largeHash() {
  const chunk = Buffer.from(Array.from({ length: 251 * 4096 }, (_, index) => index % 251));
  const hash = createHash('sha256');
  for (let remaining = 104857600; remaining > 0; remaining -= chunk.length) hash.update(chunk.subarray(0, Math.min(remaining, chunk.length)));
  return hash.digest('hex');
}
const stages = ['primitives', 'clients', 'scale', 'soak', 'rename-delete-edit', 'portable-config', 'large-file', 'interrupted-transfer'];
function safeEvidence(value) {
  const output = {};
  for (const key of ['records', 'bytes', 'files', 'ticks', 'since']) if (value[key] !== undefined) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error('Invalid evidence count');
    output[key] = value[key];
  }
  for (const key of ['hashes', 'reconstructedHashes', 'requests', 'conflicts']) if (value[key] !== undefined) {
    if (!Array.isArray(value[key]) || !value[key].every(item => ['requests', 'conflicts'].includes(key) ? Number.isSafeInteger(item) && item >= 0 : typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))) throw new Error('Invalid evidence values');
    output[key] = value[key];
  }
  if (value.aggregateHash !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(value.aggregateHash)) throw new Error('Invalid evidence hash');
    output.aggregateHash = value.aggregateHash;
  }
  return output;
}

// No browser launch, authorization, credential access, or remote cleanup here.
export async function createLiveAcceptance({ pages, pluginId, fixtureDirectory, rootName, hooks = {} }) {
  if (!/^qa-[a-z0-9-]{3,70}$/.test(rootName ?? '')) throw new Error('Explicit synthetic qa- root name required');
  if (!Array.isArray(pages) || pages.length !== 3 || new Set(pages).size !== 3) throw new Error('Three independent authorized pages required');
  if (!/^[a-z0-9-]+$/.test(pluginId ?? '') || !isAbsolute(fixtureDirectory ?? '')) throw new Error('Explicit plugin and private fixture directory required');
  const fixture = await realpath(fixtureDirectory);
  if ((await lstat(fixture)).mode & 0o077) throw new Error('Private fixture directory must have mode 0700');
  const roots = [], openedRoots = [];
  for (const page of pages) {
    const info = await page.evaluate(browserCommand, { command: 'inspect', pluginId });
    const canonicalRoot = await realpath(info.root ?? '/');
    const local = relative(fixture, canonicalRoot);
    if (!info.ready || !local || local.startsWith('..') || isAbsolute(local)) throw new Error('Authorized page must own a synthetic vault inside fixture');
    roots.push(canonicalRoot);
    openedRoots.push(info.root);
  }
  if (new Set(roots).size !== 3) throw new Error('Three independent vaults required');
  const manifestPath = join(fixture, 'live-acceptance.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid acceptance manifest'); }
  const identity = digest(JSON.stringify([pluginId, rootName, roots]));
  if (manifest && (manifest.schema !== 1 || manifest.identity !== identity)) throw new Error('Acceptance fixture identity changed');
  manifest ??= { schema: 1, identity, rootName, stages: {}, ids: Object.fromEntries(['create', 'blob', 'record', 'entity', 'device'].map(key => [key, randomUUID()])) };
  const persist = async () => {
    const temporary = manifestPath + '.tmp';
    const handle = await open(temporary, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(manifest, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, manifestPath);
    const dir = await open(fixture, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  };
  let busy = false;
  const matrixPaths = ['rename-edit.md', 'renamed-edit.md', 'delete-edit.md'];
  const invoke = async (index, command, extra = {}) => pages[index].evaluate(browserCommand, { command, pluginId, expectedRoot: openedRoots[index], rootName, ids: manifest.ids, bindings: manifest.bindings ?? {}, allowedConflictPaths: manifest.stages['rename-delete-edit']?.status === 'passed' ? matrixPaths : [], ...extra });
  const pin = async (key, descriptor) => {
    if (!descriptor || !/^[a-zA-Z0-9_-]+$/.test(descriptor.rootId) || !/^[a-zA-Z0-9_-]+$/.test(descriptor.descriptorId) || !/^[0-9a-f-]{36}$/.test(descriptor.vaultId) || descriptor.protocol !== 'append-only-history-v1' || descriptor.schema !== 1 || descriptor.name !== rootName + (key === 'primitive' ? '-primitive' : '')) throw new Error('Invalid fixture descriptor');
    const safe = Object.fromEntries(['schema', 'protocol', 'rootId', 'descriptorId', 'vaultId', 'name'].map(field => [field, descriptor[field]]));
    manifest.bindings ??= {};
    if (manifest.bindings[key] && JSON.stringify(manifest.bindings[key]) !== JSON.stringify(safe)) throw new Error('Fixture binding changed');
    manifest.bindings[key] = safe; await persist();
  };
  return {
    manifestPath,
    async runStage(stage, { retry = false } = {}) {
      if (!stages.includes(stage)) throw new Error('Unknown acceptance stage');
      if (busy) throw new Error('Acceptance stage already running');
      const prior = manifest.stages[stage];
      if (prior && !['passed', 'pending'].includes(prior.status) && !retry) throw new Error('Interrupted stage requires explicit retry');
      if (prior?.status === 'passed' && stage !== 'soak') return prior;
      if (stage === 'interrupted-transfer' && typeof hooks.interruptedTransfer !== 'function') {
        manifest.stages[stage] = { status: 'not-verified', elapsedMs: 0 }; await persist(); return structuredClone(manifest.stages[stage]);
      }
      if (!['primitives', 'clients', 'interrupted-transfer'].includes(stage) && manifest.stages.clients?.status !== 'passed') throw new Error('Clients stage must pass first');
      busy = true;
      const started = Date.now();
      manifest.stages[stage] = { status: 'running', started, ...(stage === 'soak' ? { since: prior?.since ?? started, ticks: prior?.ticks ?? 0, lastTick: prior?.lastTick ?? started, maxGapMs: Math.max(prior?.maxGapMs ?? 0, started - (prior?.lastTick ?? started)) } : {}) };
      try {
        await persist(); // Freeze operation identities before any remote mutation.
        let evidence;
        if (stage === 'primitives') {
          if (!manifest.bindings?.primitive) await pin('primitive', await invoke(0, 'primitive-create'));
          evidence = await invoke(0, 'primitives');
        }
        if (stage === 'interrupted-transfer') {
          const proof = await hooks.interruptedTransfer({ pages, pluginId, fixtureDirectory: fixture, rootName });
          if (proof?.verified !== true) {
            manifest.stages[stage] = { status: 'not-verified', elapsedMs: Date.now() - started }; await persist(); return structuredClone(manifest.stages[stage]);
          }
          evidence = safeEvidence(proof);
          if (!evidence.hashes?.length || !evidence.bytes) throw new Error('Interrupted transfer needs verified hash and byte evidence');
        }
        if (stage === 'clients') {
          if (!manifest.bindings?.shared) await pin('shared', await invoke(0, 'create'));
          await invoke(0, 'seed', { count: 3 }); await invoke(0, 'sync');
          await invoke(1, 'join'); await invoke(1, 'sync');
          const first = await invoke(0, 'hashes'), second = await invoke(1, 'hashes');
          if (JSON.stringify(first) !== JSON.stringify(seedHashes(3)) || JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Initial reconstruction differs');
          await invoke(0, 'pause'); await invoke(1, 'pause');
          await invoke(0, 'edit', { version: 'left' }); await invoke(1, 'edit', { version: 'right' });
          await invoke(0, 'resume'); await invoke(1, 'resume');
          for (const index of [0, 1, 0]) await invoke(index, 'sync', { allowedConflictPaths: ['scale-00000.md'] });
          const counts = await Promise.all([0, 1].map(index => invoke(index, 'conflicts')));
          if (counts.some(value => value < 1)) throw new Error('Concurrent branch was lost');
          await invoke(0, 'resolve'); await invoke(0, 'sync'); await invoke(1, 'sync');
          await invoke(2, 'join'); await invoke(2, 'sync');
          const resolved = await Promise.all(pages.map((_page, index) => invoke(index, 'hashes')));
          const remaining = await Promise.all(pages.map((_page, index) => invoke(index, 'conflicts')));
          if (remaining.some(count => count !== 0) || resolved.some(value => JSON.stringify(value) !== JSON.stringify(resolved[0]))) throw new Error('Resolved reconstruction differs');
          evidence = { conflicts: counts, reconstructedHashes: resolved[0] };
        }
        if (stage === 'rename-delete-edit') {
          await invoke(0, 'matrix-seed');
          for (let index = 0; index < 3; index++) await invoke(index, 'sync');
          await invoke(0, 'pause'); await invoke(1, 'pause');
          await invoke(0, 'matrix-move-delete'); await invoke(1, 'matrix-edit');
          await invoke(0, 'resume'); await invoke(1, 'resume');
          for (const index of [0, 1, 0, 2]) await invoke(index, 'sync', { allowedConflictPaths: matrixPaths });
          const counts = await Promise.all(pages.map((_page, index) => invoke(index, 'matrix-conflicts')));
          if (counts.some(count => count < 2)) throw new Error('Rename/delete concurrent edits were not preserved');
          evidence = { conflicts: counts };
        }
        if (stage === 'portable-config') {
          for (let index = 0; index < 3; index++) await invoke(index, 'config-enable');
          for (let index = 0; index < 3; index++) await invoke(index, 'sync');
          await invoke(0, 'config-edit');
          for (let index = 0; index < 3; index++) await invoke(index, 'sync');
          const verified = await Promise.all(pages.map((_page, index) => invoke(index, 'config-verify')));
          if (verified.some(value => value !== true)) throw new Error('Portable editor setting did not converge');
          evidence = { files: 1 };
        }
        if (stage === 'large-file') {
          await invoke(0, 'large-seed');
          const requests = [];
          for (let index = 0; index < 3; index++) requests.push(await invoke(index, 'sync'));
          const values = await Promise.all(pages.map((_page, index) => invoke(index, 'large-verify')));
          const expected = largeHash();
          if (values.some(value => value.size !== 104857600 || value.hash !== expected)) throw new Error('Large host transfer did not converge');
          evidence = { bytes: 104857600, hashes: [values[0].hash], requests };
        }
        if (stage === 'scale') {
          await invoke(0, 'seed', { count: 10000, scaleOnly: true });
          const requests = [];
          for (let index = 0; index < 3; index++) requests.push(await invoke(index, 'sync'));
          const snapshots = await Promise.all(pages.map((_page, index) => invoke(index, 'hashes', { scaleOnly: true })));
          const expected = JSON.stringify(seedHashes(10000));
          if (snapshots.some(value => JSON.stringify(value) !== expected)) throw new Error('Scale reconstruction differs');
          evidence = { files: 10000, requests, aggregateHash: digest(JSON.stringify(snapshots[0])) };
        }
        if (stage === 'soak') {
          const tick = manifest.stages.soak.ticks;
          await invoke(0, 'seed', { count: 1, tick });
          for (let index = 0; index < 3; index++) await invoke(index, 'sync');
          const snapshots = await Promise.all(pages.map((_page, index) => invoke(index, 'hashes', { soakOnly: true })));
          const expected = JSON.stringify(Array.from({ length: tick + 1 }, (_, index) => ({ name: `soak-${index}.md`, hash: digest(`Synthetic fixture 0 ${index}`) })).sort((a, b) => a.name.localeCompare(b.name)).map(item => item.hash));
          if (snapshots.some(value => JSON.stringify(value) !== expected)) throw new Error('Soak reconstruction differs');
          evidence = { ticks: tick + 1, since: manifest.stages.soak.since, aggregateHash: digest(JSON.stringify(snapshots[0])) };
        }
        // Results are deliberately fixed schemas: never persist arbitrary renderer diagnostics.
        manifest.stages[stage] = { ...manifest.stages[stage], ...safeEvidence(evidence), elapsedMs: Date.now() - started, status: stage === 'soak' && Date.now() - evidence.since < 86400000 ? 'pending' : 'passed' };
        if (stage === 'soak') {
          const state = manifest.stages.soak; state.lastTick = Date.now();
          const proof = typeof hooks.soakEvidence === 'function' ? await hooks.soakEvidence() : null;
          state.offlineRestartVerified = proof?.offlineRestartVerified === true;
          if (state.maxGapMs > 5400000 || !state.offlineRestartVerified) state.status = 'not-verified';
          else if (state.ticks < 25 || Date.now() - state.since < 86400000) state.status = 'pending';
        }
        await persist(); return structuredClone(manifest.stages[stage]);
      } catch {
        manifest.stages[stage].status = 'failed'; manifest.stages[stage].elapsedMs = Date.now() - started;
        await persist(); throw new Error('Acceptance stage failed; inspect isolated client safely');
      } finally { busy = false; }
    },
  };
}

async function browserCommand(input) {
  const app = window.app, plugin = app?.pluginManager?.getPlugin(input.pluginId);
  if (input.command === 'inspect') return { root: app?.vault?.root, ready: Boolean(app?.workspace?.layoutReady && plugin?.qaProvider) };
  if (app?.vault?.root !== input.expectedRoot || !plugin?.qaProvider) throw new Error('Fixture changed');
  const provider = plugin.qaProvider, signal = new AbortController().signal;
  const bytes = text => new TextEncoder().encode(text).buffer;
  const hash = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(x => x.toString(16).padStart(2, '0')).join('');
  const sync = app.sync;
  if (input.command === 'primitive-create') return provider.createVault({ name: input.rootName + '-primitive', operationId: input.ids.create }, signal);
  if (input.command === 'primitives') {
    const binding = input.bindings.primitive;
    const replay = await provider.createVault({ name: input.rootName + '-primitive', operationId: input.ids.create }, signal);
    if (['schema', 'protocol', 'vaultId', 'rootId', 'descriptorId', 'name'].some(key => binding[key] !== replay[key])) throw new Error('Create replay differs');
    const session = await provider.open({ binding, deviceId: input.ids.device }, signal);
    try {
      const data = bytes('Synthetic immutable acceptance bytes'), sha256 = await hash(data);
      const upload = { operationId: input.ids.blob, data, sha256, size: data.byteLength };
      // Discard the first successful response, then replay the frozen operation.
      await session.putBlob(upload, signal);
      const blob = await session.putBlob(upload, signal);
      if (await hash(await session.readBlob(blob, signal)) !== sha256) throw new Error('Blob hash differs');
      const cancelled = new AbortController(); cancelled.abort(); let rejected = false;
      try { await session.putBlob(upload, cancelled.signal); } catch { rejected = true; }
      if (!rejected) throw new Error('Cancelled upload accepted');
      const record = { schema: 1, vaultId: binding.vaultId, recordId: input.ids.record, operationId: input.ids.record, deviceId: input.ids.device, entityId: input.ids.entity, namespace: 'content', parents: [], kind: 'file', deleted: false, location: { parentId: null, name: 'synthetic.bin' }, blob };
      await session.appendRecord(record, signal); await session.appendRecord(record, signal);
      const scan = await session.scan(undefined, signal);
      if (scan.status !== 'complete' || scan.records.filter(value => value.recordId === record.recordId).length !== 1) throw new Error('Append replay differs');
      return { hashes: [sha256], records: 1, bytes: data.byteLength };
    } finally { await session.close(); }
  }
  if (input.command === 'create' || input.command === 'join') {
    await sync.activate(provider.id);
    const found = (await sync.discoverVaults()).filter(item => item.name === input.rootName);
    if (input.command === 'create') {
      if (found.length) throw new Error('Unpinned remote root requires explicit operator adoption');
      await sync.createVault(input.rootName);
    } else {
      const pinned = input.bindings.shared;
      if (!pinned || !found.some(item => item.vaultId === pinned.vaultId && item.rootId === pinned.rootId && item.descriptorId === pinned.descriptorId)) throw new Error('Pinned root unavailable');
      await sync.joinVault(pinned);
    }
    await sync.updateScope({ mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
    if (input.command === 'create') {
      const created = (await sync.discoverVaults()).filter(item => item.name === input.rootName);
      if (created.length !== 1) throw new Error('Created root discovery ambiguous');
      return created[0];
    }
    return;
  }
  if (input.command === 'seed') {
    for (let index = 0; index < input.count; index++) {
      const name = input.tick === undefined ? `${input.scaleOnly ? 'bench' : 'scale'}-${String(index).padStart(5, '0')}.md` : `soak-${input.tick}.md`;
      await app.host.vaultFiles.write(name, `Synthetic fixture ${index} ${input.tick ?? 0}`);
    }
    return;
  }
  if (input.command === 'edit') { await app.host.vaultFiles.write('scale-00000.md', `Synthetic concurrent ${input.version}`); return; }
  if (input.command === 'matrix-seed' || input.command === 'matrix-edit') {
    for (const name of ['rename-edit.md', 'delete-edit.md']) await app.host.vaultFiles.write(name, input.command === 'matrix-seed' ? 'Synthetic original' : 'Synthetic offline edit');
    return;
  }
  if (input.command === 'matrix-move-delete') { await app.host.vaultFiles.rename('rename-edit.md', 'renamed-edit.md'); await app.host.vaultFiles.trash('delete-edit.md'); return; }
  if (input.command === 'matrix-conflicts') return (await sync.listConflicts()).filter(conflict => ['rename-edit.md', 'renamed-edit.md', 'delete-edit.md'].includes(conflict.path)).length;
  if (input.command === 'config-enable') return sync.updateScope({ mainSettings: true });
  if (input.command === 'config-edit') return app.vault.setConfig('readableLineLength', false);
  if (input.command === 'config-verify') return (await app.host.config.read('app'))?.readableLineLength === false && app.settings.readableLineLength === false;
  if (input.command === 'large-seed') { const data = new Uint8Array(104857600); for (let index = 0; index < data.length; index++) data[index] = index % 251; await app.host.vaultFiles.writeBinary('large-synthetic.bin', data.buffer); return; }
  if (input.command === 'large-verify') { const data = await app.host.vaultFiles.readBinary('large-synthetic.bin'); return { size: data.byteLength, hash: await hash(data) }; }
  if (input.command === 'pause') return sync.pause();
  if (input.command === 'resume') return sync.resume();
  if (input.command === 'conflicts') return (await sync.listConflicts()).length;
  if (input.command === 'resolve') {
    for (const conflict of sync.getHistoryDetails()?.conflicts ?? []) {
      if (!conflict.heads.length) throw new Error('Conflict has no selectable version');
      await sync.resolveHistoryConflict({ entityId: conflict.entityId, heads: conflict.heads, choice: { kind: 'version', recordId: conflict.heads[0] } });
    }
    return;
  }
  if (input.command === 'sync') {
    const network = app.host.network, original = network.request; let requests = 0;
    network.request = function (...args) { requests++; return original.apply(this, args); };
    try {
      await sync.preview(); await sync.run({ approvePreview: true });
      const details = sync.getHistoryDetails(), status = sync.getStatus();
      if (!details || details.pending || details.blocked.length || details.excluded.length || !['idle', 'conflict'].includes(status.state) || details.conflicts.some(conflict => !input.allowedConflictPaths.includes(conflict.path))) throw new Error('Sync has unexpected blocked or unresolved state');
      return requests;
    }
    finally { network.request = original; }
  }
  if (input.command === 'hashes') {
    const scan = await app.host.vaultFiles.reconcileScan();
    if (scan.status !== 'complete') throw new Error('Incomplete scan');
    const entries = scan.entries.filter(entry => !entry.isFolder && (input.soakOnly ? /^soak-\d+\.md$/.test(entry.path) : input.scaleOnly ? /^bench-\d{5}\.md$/.test(entry.path) : /^scale-\d{5}\.md$/.test(entry.path))).sort((a, b) => a.path.localeCompare(b.path));
    const result = [];
    for (const entry of entries) result.push(await hash(await app.host.vaultFiles.readBinary(entry.path)));
    return result;
  }
  throw new Error('Unknown acceptance command');
}

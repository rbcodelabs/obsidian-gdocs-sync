import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLiveAcceptance } from './live-acceptance.mjs';
const descriptor = { schema: 1, protocol: 'append-only-history-v1', name: 'qa-synthetic-primitive', vaultId: '12345678-1234-4234-8234-123456789012', rootId: 'root', descriptorId: 'descriptor' };

async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), 'acceptance-runner-'));
  const calls = [];
  for (let index = 0; index < 3; index++) await mkdir(join(directory, `vault-${index}`));
  const pages = [0, 1, 2].map(index => ({ evaluate: async (_fn, input) => {
    calls.push(input);
    if (input.command === 'inspect') return { root: join(directory, `vault-${index}`), ready: true };
    return { hashes: [], counts: { requests: 1 }, status: 'passed' };
  } }));
  try { await work({ directory, pages, calls }); } finally { await rm(directory, { recursive: true, force: true }); }
}
test('requires a synthetic name before touching authorized pages', () => fixture(async f => {
  await assert.rejects(createLiveAcceptance({ pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'Personal' }), /synthetic/);
  assert.equal(f.calls.length, 0);
}));
test('constructing a runner inspects isolation but does not create remote data', () => fixture(async f => {
  const runner = await createLiveAcceptance({ pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' });
  assert.ok(runner.manifestPath);
  assert.ok(f.calls.every(call => call.command === 'inspect'));
}));
test('rejects duplicate pages and vaults outside the fixture', () => fixture(async f => {
  await assert.rejects(createLiveAcceptance({ pages: [f.pages[0], f.pages[0], f.pages[2]], pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' }), /independent/);
  f.pages[0].evaluate = async () => ({ root: '/', ready: true });
  await assert.rejects(createLiveAcceptance({ pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' }), /fixture/);
}));
test('persists only redacted failure status and requires explicit retry', () => fixture(async f => {
  const runner = await createLiveAcceptance({ pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' });
  f.pages[0].evaluate = async () => { throw new Error('secret-token https://private.invalid'); };
  await assert.rejects(runner.runStage('primitives'), /^Error: Acceptance stage failed; inspect isolated client safely$/);
  const manifest = await readFile(runner.manifestPath, 'utf8');
  assert.ok(!manifest.includes('secret-token')); assert.ok(!manifest.includes('private.invalid'));
  assert.equal(JSON.parse(manifest).stages.primitives.status, 'failed');
  await assert.rejects(runner.runStage('primitives'), /explicit retry/);
}));
test('does not persist arbitrary renderer diagnostics in successful evidence', () => fixture(async f => {
  const runner = await createLiveAcceptance({ pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' });
  f.pages[0].evaluate = async (_fn, input) => input.command === 'primitive-create' ? descriptor : ({ hashes: ['a'.repeat(64)], records: 1, bytes: 4, credential: 'private-token' });
  await runner.runStage('primitives');
  assert.ok(!(await readFile(runner.manifestPath, 'utf8')).includes('private-token'));
}));
test('executes replay and cancellation against a fake provider without credential access', () => fixture(async f => {
  const blobs = new Map(), records = new Map(); let creates = 0, puts = 0;
  const binding = descriptor;
  const provider = { createVault: async () => { creates++; return binding; }, open: async () => ({
    putBlob: async (input, signal) => { if (signal.aborted) throw new Error('cancelled'); puts++; blobs.set(input.operationId, input.data); return { id: input.operationId, sha256: input.sha256, size: input.size }; },
    readBlob: async blob => blobs.get(blob.id), appendRecord: async record => records.set(record.recordId, record),
    scan: async () => ({ status: 'complete', records: [...records.values()] }), close: async () => {},
  }) };
  f.pages = f.pages.map((_page, index) => ({ evaluate: async (fn, input) => {
    const previous = globalThis.window;
    globalThis.window = { app: { vault: { root: join(f.directory, `vault-${index}`) }, workspace: { layoutReady: true }, pluginManager: { getPlugin: () => ({ qaProvider: provider }) } } };
    try { return await fn(input); } finally { globalThis.window = previous; }
  } }));
  const runner = await createLiveAcceptance({ pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' });
  assert.equal((await runner.runStage('primitives')).status, 'passed');
  assert.equal(creates, 2); assert.equal(puts, 2); assert.equal(records.size, 1);
}));
test('missing real interruption hook persists not-verified rather than passing', () => fixture(async f => {
  const runner = await createLiveAcceptance({ pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' });
  const result = await runner.runStage('interrupted-transfer');
  assert.equal(result.status, 'not-verified');
  assert.equal(JSON.parse(await readFile(runner.manifestPath, 'utf8')).stages['interrupted-transfer'].status, 'not-verified');
  assert.ok(f.calls.every(call => call.command === 'inspect'));
}));
test('pins exact remote identity before blob operations', () => fixture(async f => {
  const runner = await createLiveAcceptance({ pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' });
  f.pages[0].evaluate = async (_fn, input) => {
    if (input.command === 'primitive-create') return descriptor;
    assert.deepEqual(JSON.parse(await readFile(runner.manifestPath, 'utf8')).bindings.primitive, descriptor);
    return { hashes: ['a'.repeat(64)], bytes: 1, records: 1 };
  };
  await runner.runStage('primitives');
}));
test('does not count aliases of one vault as independent clients', () => fixture(async f => {
  await symlink(join(f.directory, 'vault-0'), join(f.directory, 'alias'));
  f.pages[1].evaluate = async () => ({ root: join(f.directory, 'alias'), ready: true });
  await assert.rejects(createLiveAcceptance({ pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' }), /independent/);
}));
test('two ticks separated by 24 hours cannot pass the soak', () => fixture(async f => {
  const options = { pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic', hooks: { soakEvidence: async () => ({ offlineRestartVerified: true }) } };
  const first = await createLiveAcceptance(options); await first.runStage('interrupted-transfer');
  const manifest = JSON.parse(await readFile(first.manifestPath, 'utf8'));
  manifest.stages.clients = { status: 'passed' };
  manifest.stages.soak = { status: 'pending', ticks: 1, since: Date.now() - 86400001, lastTick: Date.now() - 86400001, maxGapMs: 0 };
  await writeFile(first.manifestPath, JSON.stringify(manifest));
  for (const page of f.pages) { const original = page.evaluate; page.evaluate = (fn, input) => input.command === 'inspect' ? original(fn, input) : Promise.resolve(input.command === 'hashes' ? [0, 1].map(index => createHash('sha256').update(`Synthetic fixture 0 ${index}`).digest('hex')) : 0); }
  const resumed = await createLiveAcceptance(options);
  assert.equal((await resumed.runStage('soak')).status, 'not-verified');
}));

for (const stage of ['soak', 'scale', 'large-file']) test(`${stage} rejects matching clients with missing or wrong synthetic bytes`, () => fixture(async f => {
  const options = { pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' };
  const first = await createLiveAcceptance(options); await first.runStage('interrupted-transfer');
  const manifest = JSON.parse(await readFile(first.manifestPath, 'utf8')); manifest.stages.clients = { status: 'passed' };
  await writeFile(first.manifestPath, JSON.stringify(manifest));
  for (const page of f.pages) { const original = page.evaluate; page.evaluate = (fn, input) => input.command === 'inspect' ? original(fn, input) : Promise.resolve(input.command === 'hashes' ? (stage === 'scale' ? Array(10000).fill('a'.repeat(64)) : []) : input.command === 'large-verify' ? { size: 104857600, hash: 'a'.repeat(64) } : 0); }
  const resumed = await createLiveAcceptance(options);
  await assert.rejects(resumed.runStage(stage), /Acceptance stage failed/);
}));

test('matching bytes cannot pass a sync with pending integrity dependencies', () => fixture(async f => {
  const options = { pages: f.pages, pluginId: 'qa-plugin', fixtureDirectory: f.directory, rootName: 'qa-synthetic' };
  const first = await createLiveAcceptance(options); await first.runStage('interrupted-transfer');
  const manifest = JSON.parse(await readFile(first.manifestPath, 'utf8')); manifest.stages.clients = { status: 'passed' }; await writeFile(first.manifestPath, JSON.stringify(manifest));
  for (let index = 0; index < f.pages.length; index++) {
    const page = f.pages[index], original = page.evaluate;
    page.evaluate = async (fn, input) => {
      if (input.command === 'inspect') return original(fn, input);
      if (input.command === 'hashes') return [createHash('sha256').update('Synthetic fixture 0 0').digest('hex')];
      if (input.command !== 'sync') return;
      const previous = globalThis.window;
      globalThis.window = { app: { vault: { root: join(f.directory, `vault-${index}`) }, pluginManager: { getPlugin: () => ({ qaProvider: {} }) }, host: { network: { request() {} } }, sync: { preview: async () => {}, run: async () => {}, getStatus: () => ({ state: 'error' }), getHistoryDetails: () => ({ pending: 1, blocked: [], excluded: [], conflicts: [] }) } } };
      try { return await fn(input); } finally { globalThis.window = previous; }
    };
  }
  const resumed = await createLiveAcceptance(options);
  await assert.rejects(resumed.runStage('soak'), /Acceptance stage failed/);
}));

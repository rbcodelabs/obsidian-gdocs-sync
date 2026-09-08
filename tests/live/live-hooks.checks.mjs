import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveHooks } from './live-hooks.mjs';
import { createHash } from 'node:crypto';
const binding = { schema: 1, protocol: 'append-only-history-v1', vaultId: '12345678-1234-4234-8234-123456789012', rootId: 'root', descriptorId: 'descriptor', name: 'qa-synthetic' };
async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), 'live-hooks-')); const calls = [];
  const clients = [];
  for (let index = 0; index < 3; index++) {
    const vault = join(directory, `vault-${index}`), profile = join(directory, `profile-${index}`);
    await mkdir(vault); await mkdir(profile);
    const process = { pid: 7000 + index, kill: signal => { calls.push(['kill', index, signal]); return true; }, once() {} };
    const electronApp = { evaluate: async () => ({ profile, pid: process.pid }), process: () => process };
    const page = { evaluate: async (_fn, input) => { calls.push([input.command, index]); return { root: vault, binding, ready: true }; } };
    clients.push({ electronApp, page, relaunch: async () => { calls.push(['relaunch', index]); return { electronApp, page: { ...page } }; } });
  }
  const pages = clients.map(client => client.page);
  try { await work({ clients, pages, fixtureDirectory: directory, pluginId: 'qa-plugin', binding, calls }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test('construction verifies isolated handles but never kills or invokes auth', () => fixture(async f => {
  const hooks = await createLiveHooks(f);
  assert.equal(typeof hooks.interruptedTransfer, 'function');
  assert.ok(f.calls.every(([command]) => command === 'inspect'));
}));
test('unknown page ownership is rejected before process access', () => fixture(async f => {
  f.pages[0] = {};
  await assert.rejects(createLiveHooks(f), /ownership/);
  assert.equal(f.calls.length, 0);
}));
test('mismatched pinned binding cannot authorize process termination', () => fixture(async f => {
  f.clients[0].page.evaluate = async () => ({ root: join(f.fixtureDirectory, 'vault-0'), binding: { ...binding, rootId: 'different' }, ready: true });
  await assert.rejects(createLiveHooks(f), /binding/);
  assert.ok(!f.calls.some(([command]) => command === 'kill'));
}));
test('unexercised soak evidence is explicitly not verified', () => fixture(async f => {
  const hooks = await createLiveHooks(f);
  assert.deepEqual(await hooks.soakEvidence({ exercise: false }), { offlineRestartVerified: false });
}));
test('offline edit restarts only the owned process and replaces the shared page', () => fixture(async f => {
  const sha256 = createHash('sha256').update('Synthetic offline restart edit').digest('hex');
  const size = Buffer.byteLength('Synthetic offline restart edit');
  for (const client of f.clients) {
    const original = client.page.evaluate;
    client.page.evaluate = (fn, input) => input.command === 'inspect' ? original(fn, input) : Promise.resolve(input.command === 'gate-status' ? { offlineRejected: 1 } : input.command === 'recovery' ? { status: 'idle', sha256, size } : undefined);
  }
  const old = f.pages[0], child = f.clients[0].electronApp.process(); let onExit;
  child.once = (_name, callback) => { onExit = callback; };
  child.kill = signal => { f.calls.push(['kill', 0, signal]); onExit(); return true; };
  const replacement = { ...old };
  f.clients[0].relaunch = async () => ({ page: replacement, electronApp: { evaluate: async () => ({ profile: join(f.fixtureDirectory, 'profile-0'), pid: 9000 }), process: () => ({ ...child, pid: 9000 }) } });
  const hooks = await createLiveHooks(f);
  assert.deepEqual(await hooks.soakEvidence(), { offlineRestartVerified: true });
  assert.equal(f.pages[0], replacement);
  assert.deepEqual(f.calls.filter(([command]) => command === 'kill'), [['kill', 0, 'SIGKILL']]);
}));
test('raw renderer errors are redacted and never cause an unverified kill', () => fixture(async f => {
  const hooks = await createLiveHooks(f); const original = f.pages[0].evaluate;
  f.pages[0].evaluate = (fn, input) => input.command === 'inspect' ? original(fn, input) : Promise.reject(new Error('private-token https://private.invalid/upload'));
  await assert.rejects(hooks.interruptedTransfer(), /^Error: Isolated recovery hook failed; evidence not verified$/);
  assert.ok(!f.calls.some(([command]) => command === 'kill'));
}));
test('a relaunch callback returning the old process cannot verify restart', () => fixture(async f => {
  const sha256 = createHash('sha256').update('Synthetic offline restart edit').digest('hex');
  for (const client of f.clients) { const original = client.page.evaluate; client.page.evaluate = (fn, input) => input.command === 'inspect' ? original(fn, input) : Promise.resolve(input.command === 'gate-status' ? { offlineRejected: 1 } : input.command === 'recovery' ? { status: 'idle', sha256, size: 30 } : undefined); }
  const child = f.clients[0].electronApp.process(); let onExit;
  child.once = (_name, callback) => { onExit = callback; }; child.kill = () => { onExit(); return true; };
  const hooks = await createLiveHooks(f);
  await assert.rejects(hooks.soakEvidence(), /not verified/);
}));
test('renderer gate recognizes a dispatched chunk without exposing request data', () => fixture(async f => {
  const hooks = await createLiveHooks(f), original = f.pages[0].evaluate;
  let dispatches = 0, observation;
  const network = { request: () => { dispatches++; return new Promise(() => {}); } };
  const window = { app: { vault: { root: join(f.fixtureDirectory, 'vault-0') }, pluginManager: { getPlugin: () => ({ qaProvider: {} }) },
    host: { network, deviceState: { read: async () => ({ binding }) }, vaultFiles: { writeBinary: async () => {} } },
    sync: { pause: async () => {}, resume: async () => {}, run: () => network.request({ method: 'PUT', url: 'https://private.invalid/session', headers: { 'Content-Range': 'bytes 0-4194303/16777216' } }) },
  } };
  f.pages[0].evaluate = async (fn, input) => {
    if (input.command === 'inspect') return original(fn, input);
    const previous = globalThis.window; globalThis.window = window;
    try { const value = await fn(input); if (input.command === 'gate-status') { observation = value; throw new Error('Stop before fake kill'); } return value; }
    finally { globalThis.window = previous; }
  };
  await assert.rejects(hooks.interruptedTransfer(), /not verified/);
  assert.equal(dispatches, 1);
  assert.deepEqual(observation, { chunkStarted: true, chunkSettled: false, offlineRejected: 0 });
  assert.ok(!f.calls.some(([command]) => command === 'kill'));
}));

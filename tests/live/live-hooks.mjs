import { realpath, lstat, readFile, open, rename } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SIZE = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bindingKey = value => JSON.stringify([value?.schema, value?.protocol, value?.vaultId, value?.rootId, value?.descriptorId]);
const syntheticHash = () => { const data = Buffer.alloc(SIZE); for (let index = 0; index < data.length; index++) data[index] = index % 251; return hash(data); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Explicit test-only mutation hooks. No launch, auth, token, or global network access. */
export async function createLiveHooks({ clients, pages, fixtureDirectory, pluginId, binding }) {
  if (!Array.isArray(clients) || clients.length !== 3 || !Array.isArray(pages) || pages.length !== 3 || clients.some((client, index) => client.page !== pages[index] || !client.electronApp || typeof client.relaunch !== 'function') || new Set(pages).size !== 3) throw new Error('Unknown client ownership');
  if (!isAbsolute(fixtureDirectory ?? '') || !/^[a-z0-9-]+$/.test(pluginId ?? '') || !binding?.rootId || !binding?.descriptorId || !binding?.vaultId) throw new Error('Explicit fixture binding required');
  const fixture = await realpath(fixtureDirectory);
  if ((await lstat(fixture)).mode & 0o077) throw new Error('Fixture must be private mode 0700');
  const inside = async value => { const canonical = await realpath(value); const part = relative(fixture, canonical); if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('Process is outside private fixture'); return canonical; };
  const inspect = async client => {
    const main = await client.electronApp.evaluate(({ app }) => ({ profile: app.getPath('userData'), pid: process.pid }));
    const page = await client.page.evaluate(pageCommand, { command: 'inspect', pluginId });
    if (!page.ready || bindingKey(page.binding) !== bindingKey(binding)) throw new Error('Pinned binding mismatch');
    const child = client.electronApp.process();
    if (!Number.isSafeInteger(main.pid) || child?.pid !== main.pid || typeof child.kill !== 'function') throw new Error('Unverified process ownership');
    return { root: await inside(page.root), rootSpelling: page.root, profile: await inside(main.profile), child };
  };
  const identities = [];
  for (const client of clients) identities.push(await inspect(client));
  if (new Set(identities.map(value => value.root)).size !== 3 || new Set(identities.map(value => value.profile)).size !== 3 || new Set(identities.map(value => value.child.pid)).size !== 3) throw new Error('Independent processes, profiles and vaults required');
  const manifestPath = join(fixture, 'live-hooks.json');
  const identity = hash(JSON.stringify([bindingKey(binding), identities.map(value => [value.root, value.profile])]));
  let state;
  try { state = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid hook manifest'); }
  if (state && state.identity !== identity) throw new Error('Hook fixture identity changed');
  state ??= { schema: 1, identity, operation: randomUUID(), interrupted: false, offlineRestartVerified: false };
  const save = async () => {
    const temporary = manifestPath + '.tmp'; const file = await open(temporary, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, manifestPath); const dir = await open(fixture, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  };
  const verify = async index => {
    if (!Number.isInteger(index) || !clients[index] || clients[index].page !== pages[index]) throw new Error('Unknown client ownership');
    const current = await inspect(clients[index]), expected = identities[index];
    if (current.root !== expected.root || current.rootSpelling !== expected.rootSpelling || current.profile !== expected.profile) throw new Error('Fixture changed');
    return current;
  };
  const invoke = async (index, command, extra = {}) => {
    await verify(index);
    return pages[index].evaluate(pageCommand, { command, pluginId, binding, root: identities[index].rootSpelling, ...extra });
  };
  const until = async (read, accepted, timeout = 120000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await read(); if (accepted(value)) return value; await wait(25); }
    throw new Error('Verified phase timed out');
  };
  const restart = async index => {
    const current = await verify(index);
    let timeout;
    const exited = new Promise((resolve, reject) => {
      current.child.once('exit', resolve);
      timeout = setTimeout(() => reject(new Error('Owned process did not exit')), 30000);
    });
    try {
      if (!current.child.kill('SIGKILL')) throw new Error('Owned process was not terminated');
      await exited;
    } finally { clearTimeout(timeout); }
    const replacement = await clients[index].relaunch();
    const candidate = { ...clients[index], ...replacement };
    const checked = await inspect(candidate);
    if (checked.root !== current.root || checked.rootSpelling !== current.rootSpelling || checked.profile !== current.profile || checked.child.pid === current.child.pid || replacement.page === pages[index]) throw new Error('Relaunch did not replace the isolated process');
    clients[index].electronApp = replacement.electronApp; clients[index].page = replacement.page;
    pages[index] = replacement.page; identities[index].child = checked.child;
  };
  const recovered = async (path, sha256, size) => {
    // Do not preview/replan away the pending batch: startup must recover it itself.
    await until(() => invoke(0, 'recovery', { path }), value => value.status === 'idle' && value.sha256 === sha256 && value.size === size);
    for (let index = 1; index < 3; index++) {
      await invoke(index, 'sync');
      await until(() => invoke(index, 'recovery', { path }), value => value.status === 'idle' && value.sha256 === sha256 && value.size === size);
    }
  };
  let busy = false;
  const execute = async (offline) => {
    if (busy) throw new Error('Hook already running'); busy = true;
    const path = `qa-${offline ? 'offline' : 'interrupted'}-${state.operation}.${offline ? 'md' : 'bin'}`;
    const expected = offline ? hash('Synthetic offline restart edit') : syntheticHash();
    const size = offline ? Buffer.byteLength('Synthetic offline restart edit') : SIZE;
    try {
      state.phase = 'preparing'; await save();
      await invoke(0, offline ? 'offline-edit' : 'interrupt-start', { path, size });
      await until(() => invoke(0, 'gate-status'), value => offline ? value.offlineRejected > 0 : value.chunkStarted && !value.chunkSettled, 30000);
      state.phase = offline ? 'offline-observed' : 'chunk-observed'; await save();
      // Re-check after persistence; a completed chunk does not count as in-flight.
      const gate = await invoke(0, 'gate-status');
      if (!offline && (!gate.chunkStarted || gate.chunkSettled)) throw new Error('Chunk completed before interruption');
      await restart(0); state.phase = 'restarted'; await save();
      await recovered(path, expected, size);
      state[offline ? 'offlineRestartVerified' : 'interrupted'] = true;
      state.phase = 'verified'; state.sha256 = expected; state.bytes = size; await save();
      return offline ? { offlineRestartVerified: true } : { verified: true, hashes: [expected], bytes: size };
    } catch {
      state.phase = 'failed'; await save().catch(() => {});
      throw new Error('Isolated recovery hook failed; evidence not verified');
    } finally {
      // Restore only our wrapper on a surviving verified page. Never touch another app.
      await invoke(0, 'restore-gate').catch(() => {}); busy = false;
    }
  };
  return {
    manifestPath,
    interruptedTransfer: async () => execute(false),
    soakEvidence: async ({ exercise = true } = {}) => {
      if (state.offlineRestartVerified) return { offlineRestartVerified: true };
      return exercise ? execute(true) : { offlineRestartVerified: false };
    },
  };
}

async function pageCommand(input) {
  const app = window.app, plugin = app?.pluginManager?.getPlugin(input.pluginId);
  const local = app?.vault?.root;
  const stored = local ? await app.host.deviceState.read(`sync-history-binding/${local}`) : null;
  if (input.command === 'inspect') return { root: local, binding: stored?.binding, ready: Boolean(app?.workspace?.layoutReady && plugin?.qaProvider) };
  const equal = (a, b) => ['schema', 'protocol', 'vaultId', 'rootId', 'descriptorId'].every(key => a?.[key] === b?.[key]);
  if (local !== input.root || !equal(stored?.binding, input.binding) || !plugin?.qaProvider) throw new Error('Fixture changed');
  if (input.command === 'gate-status') {
    const gate = window.__liveRecoveryGate;
    return { chunkStarted: gate?.chunkStarted === true, chunkSettled: gate?.chunkSettled === true, offlineRejected: gate?.offlineRejected ?? 0 };
  }
  if (input.command === 'restore-gate') {
    const gate = window.__liveRecoveryGate;
    if (gate && app.host.network.request === gate.wrapper) app.host.network.request = gate.original;
    delete window.__liveRecoveryGate; return;
  }
  if (input.command === 'interrupt-start' || input.command === 'offline-edit') {
    await app.sync.pause();
    if (window.__liveRecoveryGate) throw new Error('Gate already installed');
    const network = app.host.network;
    const gate = { original: network.request, chunkStarted: false, chunkSettled: false, offlineRejected: 0, wrapper: null };
    gate.wrapper = function(request, signal) {
      if (input.command === 'offline-edit') { gate.offlineRejected++; return Promise.reject(new Error('Synthetic offline gate')); }
      const range = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-range')?.[1];
      const chunk = request.method?.toUpperCase() === 'PUT' && /^bytes \d+-\d+\/\d+$/.test(range ?? '');
      const pending = gate.original.call(this, request, signal);
      if (chunk && !gate.chunkStarted) { gate.chunkStarted = true; void pending.then(() => { gate.chunkSettled = true; }, () => { gate.chunkSettled = true; }); }
      return pending;
    };
    window.__liveRecoveryGate = gate; network.request = gate.wrapper;
    if (input.command === 'offline-edit') await app.host.vaultFiles.write(input.path, 'Synthetic offline restart edit');
    else { const bytes = new Uint8Array(input.size); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251; await app.host.vaultFiles.writeBinary(input.path, bytes.buffer); }
    await app.sync.resume();
    void app.sync.run({}).catch(() => {});
    return;
  }
  if (input.command === 'sync') { await app.sync.run({}); return; }
  if (input.command === 'recovery') {
    let bytes;
    try { bytes = await app.host.vaultFiles.readBinary(input.path); } catch { return { status: app.sync.getStatus().state, size: 0, sha256: null }; }
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    return { status: app.sync.getStatus().state, size: bytes.byteLength, sha256 };
  }
  throw new Error('Unknown hook command');
}

import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, copyFile, realpath, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installOAuthCapture } from './oauth-capture.mjs';
import { openManualChrome } from './manual-chrome.mjs';
import { createLiveAcceptance } from './live-acceptance.mjs';
import { createLiveHooks } from './live-hooks.mjs';
import { presentWindow } from './present-window.mjs';

export const stageExitCode = status => ({ passed: 0, pending: 2, 'not-verified': 3, failed: 1 })[status] ?? 1;
export function assertAccountProofs(proofs) {
  if (proofs.length !== 3 || proofs.some(value => !/^[a-f0-9]{64}$/.test(value)) || new Set(proofs).size !== 1) throw new Error('Independent clients must use the same stable account');
}
export async function digestTree(directory) {
  const hash = createHash('sha256');
  const visit = async (path, prefix = '') => {
    for (const name of (await readdir(path)).sort()) {
      const target = join(path, name), entry = await lstat(target), key = `${prefix}${name}`;
      if (entry.isDirectory()) await visit(target, `${key}/`);
      else if (entry.isFile()) { const bytes = await readFile(target); hash.update(JSON.stringify([key, bytes.length])); hash.update(bytes); }
      else throw new Error('Build artifacts must not contain symlinks');
    }
  };
  await visit(directory); return hash.digest('hex');
}

export function parseAcceptanceArgs(args) {
  const flags = new Set(['--authorize-disposable-account', '--authorize-remote-writes', '--resume', '--retry']);
  const values = new Set(['--root', '--fixture', '--core', '--bundle', '--stage']);
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index]; if (result[key] !== undefined) throw new Error('Duplicate argument');
    if (flags.has(key)) result[key] = true;
    else if (values.has(key) && args[index + 1] && !args[index + 1].startsWith('--')) result[key] = args[++index];
    else throw new Error('Unknown or missing argument');
  }
  if (!result['--authorize-disposable-account'] || !result['--authorize-remote-writes']) throw new Error('Explicit account and remote-write authorization required');
  if (!/^qa-[a-z0-9-]{3,70}$/.test(result['--root'] ?? '')) throw new Error('Explicit synthetic qa- root required');
  for (const key of ['--fixture', '--core', '--bundle']) if (!isAbsolute(result[key] ?? '')) throw new Error('Explicit absolute directories required');
  if (!['primitives', 'clients', 'rename-delete-edit', 'portable-config', 'large-file', 'interrupted-transfer', 'scale', 'soak'].includes(result['--stage'])) throw new Error('Explicit supported stage required');
  return { rootName: result['--root'], fixtureDirectory: result['--fixture'], core: result['--core'], bundle: result['--bundle'], stage: result['--stage'], resume: Boolean(result['--resume']), retry: Boolean(result['--retry']) };
}

export async function executeStage(options, handles, dependencies = {}) {
  const hooks = {};
  const acceptance = await (dependencies.acceptance ?? createLiveAcceptance)({ ...options, ...handles, hooks });
  const readBinding = dependencies.readBinding ?? (async path => { try { return JSON.parse(await readFile(path, 'utf8')).bindings?.shared; } catch (error) { if (error.code !== 'ENOENT') throw error; } });
  const binding = await readBinding(acceptance.manifestPath);
  if (binding) Object.assign(hooks, await (dependencies.hooks ?? createLiveHooks)({ ...options, ...handles, binding }));
  return acceptance.runStage(options.stage, { retry: options.retry });
}

export async function assertInsideFixture(fixture, path) {
  const canonical = await realpath(path), part = relative(await realpath(fixture), canonical);
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('Fixture escaped');
  return canonical;
}

export async function runAcceptance(options) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const manifest = JSON.parse(await readFile(join(repo, 'manifest.json'), 'utf8'));
  if (!/^[a-z0-9-]+$/.test(manifest.id)) throw new Error('Invalid plugin identity');
  if (!options.resume) await mkdir(options.fixtureDirectory, { mode: 0o700 });
  const fixture = await realpath(options.fixtureDirectory);
  if ((await lstat(fixture)).mode & 0o077) throw new Error('Fixture must be private');
  const receipt = join(fixture, 'acceptance-launch.json');
  const sourceSha = async cwd => (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  const identity = { schema: 1, rootName: options.rootName, core: await realpath(options.core), pluginId: manifest.id, coreSha: await sourceSha(options.core), pluginSha: await sourceSha(repo), coreBuildSha256: await digestTree(join(options.core, 'dist')), pluginBundleSha256: await digestTree(options.bundle) };
  if (options.resume) {
    const prior = JSON.parse(await readFile(receipt, 'utf8'));
    if (JSON.stringify(prior) !== JSON.stringify(identity)) throw new Error('Launch identity changed');
  } else await writeFile(receipt, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  const require = createRequire(import.meta.url);
  const { _electron, chromium } = require(join(identity.core, 'node_modules/@playwright/test'));
  const clients = [], pages = [], browsers = new Set();
  let stopping = false;
  const close = async () => {
    stopping = true;
    for (const browser of browsers) await browser.close().catch(() => {});
    for (const client of clients) await client.electronApp?.close().catch(() => {});
  };
  const onSignal = () => { void close(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    for (let index = 0; index < 3; index++) {
      const vault = join(fixture, `vault-${index}`), profile = join(fixture, `profile-${index}`);
      if (!options.resume) { await mkdir(vault, { mode: 0o700 }); await mkdir(profile, { mode: 0o700 }); }
      for (const path of [vault, profile]) await assertInsideFixture(fixture, path);
      const destination = join(vault, '.geode/plugins', manifest.id);
      for (const path of [join(vault, '.geode'), join(vault, '.geode/plugins'), destination]) {
        try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        await assertInsideFixture(fixture, path);
      }
      for (const name of ['main.js', 'manifest.json', 'styles.css']) {
        try { if (!(await lstat(join(destination, name))).isFile()) throw new Error('Unsafe plugin target'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await copyFile(join(options.bundle, 'main.js'), join(destination, 'main.js'));
      for (const name of ['manifest.json', 'styles.css']) await copyFile(join(repo, name), join(destination, name));
      if (!options.resume) {
        await writeFile(join(vault, '.geode/plugins.json'), JSON.stringify([manifest.id]), { mode: 0o600 });
        await writeFile(join(profile, 'geode.json'), JSON.stringify({ recentVaults: [vault], lastVault: vault }), { mode: 0o600 });
      }
      const launch = async () => {
        if (stopping) throw new Error('Stopped');
        const electronApp = await _electron.launch({ args: [identity.core, `--user-data-dir=${profile}`], cwd: identity.core, env: { ...process.env, GEODE_HEADLESS: '1' } });
        try {
          const page = await electronApp.firstWindow();
          await page.waitForFunction(id => window.app?.workspace?.layoutReady && window.app.pluginManager?.getPlugin(id)?.qaProvider, manifest.id, { timeout: 30000 });
          return { electronApp, page };
        } catch { await electronApp.close().catch(() => {}); throw new Error('Isolated client failed to launch'); }
      };
      const client = { ...await launch(), relaunch: launch }; clients.push(client); pages.push(client.page);
      const connected = await client.page.evaluate(id => Boolean(window.app.pluginManager.getPlugin(id).tokenStore.get()), manifest.id);
      if (!connected) {
        await client.page.evaluate(id => window.app.setting.openTabById(id), manifest.id);
        try { await presentWindow(client.electronApp, index + 1); }
        catch { process.stderr.write(`Client ${index + 1}: QA window presentation failed. Check macOS desktop/Spaces; no sign-in started.\n`); throw new Error('QA presentation failed'); }
        process.stdout.write(`Client ${index + 1}: click Connect in the isolated test window and authorize the selected disposable account.\n`);
        await client.page.waitForFunction(id => typeof window.app.pluginManager.getPlugin(id).qaAuthUrl === 'string', manifest.id, { timeout: 600000 });
        const start = await client.page.evaluate(id => window.app.pluginManager.getPlugin(id).qaAuthUrl, manifest.id);
        const url = new URL(start);
        if (url.protocol !== 'https:' || url.pathname !== '/api/auth/start' || url.searchParams.get('callback_app') !== 'geode' || !url.searchParams.get('state')) throw new Error('Invalid isolated authorization');
        const browser = await openManualChrome(chromium); browsers.add(browser);
        const { context } = browser;
        let failed = false;
        await installOAuthCapture(context, { proxyOrigin: url.origin, expectedState: url.searchParams.get('state'), onFailure: () => { failed = true; }, onCallback: async params => {
          await client.page.evaluate(async ({ id, params }) => {
            const plugin = window.app.pluginManager.getPlugin(id);
            if (!plugin.tokenStore.hasSecureStorage()) throw new Error('Secure storage unavailable');
            await plugin.auth.handleCallback(params);
          }, { id: manifest.id, params });
        } });
        const authPage = await context.newPage(); await authPage.goto(start).catch(() => { throw new Error('Authorization navigation failed'); });
        await client.page.waitForFunction(id => Boolean(window.app.pluginManager.getPlugin(id).tokenStore.get()), manifest.id, { timeout: 600000 });
        if (failed) throw new Error('Isolated authorization rejected');
        await browser.close(); browsers.delete(browser);
      }
    }
    if (stopping) throw new Error('Stopped');
    const proofs = [];
    for (const page of pages) proofs.push(await page.evaluate(async id => {
      // QA-only introspection of the actual provider's generation-fenced account lookup.
      // Only its one-way fingerprint crosses the renderer boundary, never tokens or account IDs.
      const provider = window.app.pluginManager.getPlugin(id).qaProvider;
      const { accountId } = await provider.context(new AbortController().signal);
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accountId));
      return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
    }, manifest.id));
    assertAccountProofs(proofs);
    const accountReceipt = join(fixture, 'account-proof.json');
    try { if (JSON.parse(await readFile(accountReceipt, 'utf8')).sha256 !== proofs[0]) throw new Error('Fixture account changed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(accountReceipt, JSON.stringify({ sha256: proofs[0] }), { mode: 0o600, flag: 'wx' }); }
    const result = await executeStage({ ...options, fixtureDirectory: fixture }, { clients, pages, pluginId: manifest.id });
    process.stdout.write(`Stage ${options.stage}: ${result.status}. Private evidence retained in the explicit fixture.\n`);
    return result;
  } finally { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); await close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = stageExitCode((await runAcceptance(parseAcceptanceArgs(process.argv.slice(2)))).status); }
  catch { process.stderr.write('Acceptance launch or stage failed safely; inspect only the private fixture. Sensitive diagnostics withheld.\n'); process.exitCode = 1; }
}

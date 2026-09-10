// Requires explicit user authorization; does not create remote roots or run sync automatically.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installOAuthCapture } from './oauth-capture.mjs';
import { openManualChrome } from './manual-chrome.mjs';

if (!process.argv.includes('--authorize-disposable-account')) throw new Error('Explicit disposable-account authorization is required');
const core = process.env.GEODE_QA_CORE;
const bundle = process.env.GEODE_QA_OUTPUT;
if (!core?.startsWith('/') || !bundle?.startsWith('/')) throw new Error('Set GEODE_QA_CORE and GEODE_QA_OUTPUT to explicit absolute directories');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { _electron, chromium } = require(join(core, 'node_modules/@playwright/test'));
let app; let browser;
const close = async () => { await browser?.close().catch(() => undefined); await app?.close().catch(() => undefined); };
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
try {
  const temporary = await mkdtemp(join(tmpdir(), 'geode-managed-live-'));
  const vault = join(temporary, 'synthetic-vault'); const profile = join(temporary, 'isolated-profile');
  const manifest = JSON.parse(await readFile(join(repo, 'manifest.json'), 'utf8'));
  const destination = join(vault, '.geode/plugins', manifest.id);
  await mkdir(destination, { recursive: true, mode: 0o700 }); await mkdir(profile, { mode: 0o700 });
  await copyFile(join(bundle, 'main.js'), join(destination, 'main.js'));
  for (const name of ['manifest.json', 'styles.css']) await copyFile(join(repo, name), join(destination, name));
  await writeFile(join(vault, '.geode/plugins.json'), JSON.stringify([manifest.id]));
  await writeFile(join(profile, 'geode.json'), JSON.stringify({ recentVaults: [vault], lastVault: vault }), { mode: 0o600 });
  await writeFile(join(temporary, 'qa-fixture.json'), JSON.stringify({ schema: 1, vault, profile, remoteRoots: [], note: 'Only explicitly named disposable roots and synthetic data. No automatic remote cleanup.' }, null, 2), { mode: 0o600 });
  // Headless mode disables global protocol registration/single-instance routing; show only our window afterward.
  app = await _electron.launch({ args: [core, `--user-data-dir=${profile}`], cwd: core, env: { ...process.env, GEODE_HEADLESS: '1' } });
  const page = await app.firstWindow();
  await page.waitForFunction(id => window.app?.pluginManager?.getPlugin(id)?.qaAuthUrl === null, manifest.id, { timeout: 30000 });
  await page.evaluate(id => window.app.setting.openTabById(id), manifest.id);
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  process.stdout.write(`Isolated test client ready. Private fixture manifest: ${join(temporary, 'qa-fixture.json')}\nClick Connect in this test window only. No remote vault has been created.\n`);
  await page.waitForFunction(id => typeof window.app.pluginManager.getPlugin(id).qaAuthUrl === 'string', manifest.id, { timeout: 0 });
  const start = await page.evaluate(id => window.app.pluginManager.getPlugin(id).qaAuthUrl, manifest.id);
  const url = new URL(start);
  if (url.protocol !== 'https:' || url.pathname !== '/api/auth/start' || url.searchParams.get('callback_app') !== 'geode' || !url.searchParams.get('state')) throw new Error('Invalid isolated start');
  browser = await openManualChrome(chromium);
  const { context } = browser;
  await installOAuthCapture(context, {
    proxyOrigin: url.origin, expectedState: url.searchParams.get('state'),
    onCallback: async params => {
      await page.evaluate(async ({ id, params }) => {
        const plugin = window.app.pluginManager.getPlugin(id);
        if (!plugin.tokenStore.hasSecureStorage()) throw new Error('Secure storage is unavailable');
        await plugin.auth.handleCallback(params);
        if (!plugin.tokenStore.get()) throw new Error('Isolated authentication was not accepted');
      }, { id: manifest.id, params });
      process.stdout.write('Account authorized only in the isolated client. Live acceptance remains pending; no sync or remote creation was started automatically.\n');
    },
    onFailure: message => process.stderr.write(`${message}\n`),
  });
  const authPage = await context.newPage();
  await authPage.goto(start).catch(() => { throw new Error('Isolated authorization navigation failed'); });
  await app.waitForEvent('close', { timeout: 0 });
} catch {
  process.stderr.write('Isolated QA session ended or failed safely; sensitive details were redacted.\n'); process.exitCode = 1;
} finally { await close(); }

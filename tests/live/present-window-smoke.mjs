// No plugin installation, tokens, sign-in, browser launch, or remote requests.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { presentWindow } from './present-window.mjs';
const core = process.env.GEODE_QA_CORE;
if (!isAbsolute(core ?? '')) throw new Error('Explicit built core required');
const { _electron } = createRequire(import.meta.url)(join(core, 'node_modules/@playwright/test'));
const fixture = await mkdtemp(join(tmpdir(), 'geode-window-only-'));
let electronApp;
try {
  const vault = join(fixture, 'synthetic-empty-vault'), profile = join(fixture, 'profile');
  await mkdir(vault); await mkdir(profile);
  await writeFile(join(profile, 'geode.json'), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  electronApp = await _electron.launch({ args: [core, `--user-data-dir=${profile}`], cwd: core, env: { ...process.env, GEODE_HEADLESS: '1' } });
  const page = await electronApp.firstWindow();
  await page.waitForFunction(() => window.app?.workspace?.layoutReady, undefined, { timeout: 30000 });
  const before = await electronApp.evaluate(({ BrowserWindow }) => { const view = BrowserWindow.getAllWindows()[0]; return { visible: view.isVisible(), focused: view.isFocused(), minimized: view.isMinimized() }; });
  const after = await presentWindow(electronApp, 1);
  console.log(JSON.stringify({ before, after, isolated: true, authStarted: false }));
} finally {
  await electronApp?.close().catch(() => {});
  await rm(fixture, { recursive: true, force: true });
}

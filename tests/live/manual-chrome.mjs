// Manual system Chrome with a disposable profile; CDP only routes the OAuth callback.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function openManualChrome(chromium) {
  if (process.platform !== 'darwin') throw new Error('Manual Chrome QA currently requires macOS');
  const profile = await mkdtemp(join(tmpdir(), 'geode-qa-chrome-'));
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  // Use a nonzero port: Chrome's port=0 mode enables its automation indicator.
  const child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  let exited = false;
  const stopped = new Promise(resolve => {
    child.once('exit', () => { exited = true; resolve(); });
    child.once('error', () => { exited = true; resolve(); });
  });
  let browser;
  const close = async () => {
    if (!exited) {
      if (browser) {
        try {
          const cdp = await browser.newBrowserCDPSession();
          await cdp.send('Browser.close');
        } catch { /* Chrome may have already closed. */ }
      }
      if (!exited) child.kill('SIGTERM');
      await Promise.race([stopped, delay(5000)]);
      if (!exited) { child.kill('SIGKILL'); await stopped; }
    }
    await browser?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  };
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100 && !exited; attempt++) {
      try {
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch { /* Wait only for this disposable browser's debugger. */ }
      await delay(100);
    }
    if (!ready) throw new Error('Manual Chrome failed to start');
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Manual Chrome context unavailable');
    return { context, profile, close };
  } catch {
    await close();
    throw new Error('Isolated manual Chrome startup failed');
  }
}

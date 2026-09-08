// Synthetic-only executable fixture. Uses an explicitly supplied local Playwright installation.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { installOAuthCapture } from './oauth-capture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? '@playwright/test');
const sentinel = 'synthetic-callback-sentinel';
let browser; let server;
try {
  let forbiddenRequests = 0;
  server = createServer((request, response) => {
    if (request.url.startsWith('/api/auth/callback')) {
      const uri = `geode://gdocs-sync?event=auth_complete&state=synthetic-state&access_token=${sentinel}&refresh_token=${sentinel}&expires_in=3600`;
      response.writeHead(307, { location: `/auth/success?callback_uri=${encodeURIComponent(uri)}` }); response.end();
    } else if (request.url.startsWith('/auth/success')) { forbiddenRequests++; response.end('Must never render'); }
    else response.end('<!doctype html><title>Synthetic authorization</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let delivered = false; const consoleMessages = [];
  await installOAuthCapture(context, { proxyOrigin: origin, expectedState: 'synthetic-state', onCallback: async params => { assert.equal(params.access_token, sentinel); delivered = true; } });
  const page = await context.newPage();
  page.on('console', message => consoleMessages.push(message.text()));
  await page.goto(`${origin}/start`);
  await page.goto(`${origin}/api/auth/callback?code=synthetic-code&state=synthetic-state`);
  const cdp = await context.newCDPSession(page);
  const history = await cdp.send('Page.getNavigationHistory');
  assert.equal(delivered, true); assert.equal(forbiddenRequests, 0);
  assert.equal(page.url(), `${origin}/isolated-qa-auth-complete`);
  assert.equal(JSON.stringify(history).includes(sentinel), false);
  assert.equal(JSON.stringify(history).includes('callback_uri'), false);
  assert.equal(consoleMessages.some(message => message.includes(sentinel)), false);
  process.stdout.write('PASS: synthetic callback delivered in memory; token URL absent from browser history/address/console; no success-page request or OS deep link.\n');
} catch {
  process.stderr.write('FAIL: isolated callback synthetic smoke failed (details redacted).\n'); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}

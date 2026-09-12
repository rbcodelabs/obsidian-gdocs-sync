// Synthetic-only: localhost redirects, inert success pages, no Google or OS navigation.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { installOAuthCapture, createAuthCheckpointReporter } from './oauth-capture.mjs';
import { openManualChrome } from './manual-chrome.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? '@playwright/test');
const sentinel = 'synthetic-token-sentinel';
const state = 'synthetic-state-sentinel';
const code = 'synthetic-code-sentinel';
const encodedState = Buffer.from(JSON.stringify({ state, callbackApp: 'geode' })).toString('base64url');
const servers = [];
let browser;
let check = 'startup';
async function serve(handler) {
  const server = createServer(handler); servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
try {
  let exchanges = 0, forbiddenRequests = 0;
  let scenario = 'direct';
  const proxy = await serve((request, response) => {
    if (request.url.startsWith('/api/auth/callback')) {
      exchanges++;
      const uri = new URL('geode://gdocs-sync');
      for (const [key, value] of Object.entries({ event: 'auth_complete', state: scenario === 'response-state' ? 'wrong-state' : state, access_token: sentinel, refresh_token: sentinel, expires_in: '3600' })) uri.searchParams.set(key, value);
      response.writeHead(307, { location: `/auth/success?callback_uri=${encodeURIComponent(uri.toString())}` }); response.end();
    } else if (request.url.startsWith('/auth/success')) {
      forbiddenRequests++; response.end('<!doctype html><title>Inert forbidden page</title>No script or OS navigation');
    } else response.end('<!doctype html><title>Synthetic endpoint</title>');
  });
  const unexpected = await serve((_request, response) => { forbiddenRequests++; response.end('Must not be requested'); });
  const provider = await serve((request, response) => {
    if (scenario === 'nested-query' && request.url === '/consent') {
      response.end(`<!doctype html><title>Synthetic consent</title><button onclick="location.href='/approve?next=${proxy}/api/auth/callback'">Approve synthetic consent</button>`); return;
    }
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const destination = scenario === 'unknown-origin' ? unexpected : proxy;
    const callbackState = scenario === 'request-state' ? 'wrong-state' : encodedState;
    const location = request.url === '/consent' ? '/redirect-hop' : `${destination}/api/auth/callback?code=${code}&state=${callbackState}`;
    response.writeHead(request.url === '/consent' ? 303 : 302, { location }); response.end();
  });
  browser = await openManualChrome(chromium);
  const { context } = browser;
  assert.equal((await stat(browser.profile)).mode & 0o777, 0o700);
  for (scenario of ['nested-query', 'redirect-chain', 'direct', 'unknown-origin', 'request-state', 'response-state']) {
    check = `${scenario}:setup`;
    exchanges = 0; forbiddenRequests = 0;
    let delivered = 0, failures = 0;
    const page = await context.newPage();
    const messages = [];
    const checkpoints = [];
    page.on('console', message => messages.push(message.text()));
    assert.equal(await page.evaluate(() => navigator.webdriver), false);
    const capture = await installOAuthCapture(page, { proxyOrigin: proxy, expectedState: state, timeoutMs: 10000,
      onCheckpoint: createAuthCheckpointReporter(1, text => checkpoints.push(text)),
      onCallback: async params => { assert.equal(params.access_token, sentinel); delivered++; },
      onFailure: () => { failures++; },
    });
    check = `${scenario}:navigation`;
    const consent = scenario === 'nested-query' ? provider.replace('127.0.0.1', 'localhost') : provider;
    await page.goto(scenario === 'direct' ? `${proxy}/api/auth/callback?code=${code}&state=${encodedState}` : `${consent}/consent`);
    if (scenario === 'nested-query') await page.getByRole('button', { name: 'Approve synthetic consent' }).click();
    const rejected = !['direct', 'redirect-chain', 'nested-query'].includes(scenario);
    assert.equal(await capture.finished, !rejected);
    const diagnosticOutput = checkpoints.join('');
    if (scenario === 'nested-query') assert.ok(diagnosticOutput.includes('phase=IGNORED_NON_AUTH result=OK'));
    assert.ok(checkpoints.every(line => /^QA_AUTH client=1 phase=[A-Z_]+ result=(START|OK|FAIL)\n$/.test(line)));
    const failurePhase = { 'unknown-origin': 'CALLBACK_REQUEST', 'request-state': 'CALLBACK_STATE', 'response-state': 'CALLBACK_IDENTITY' }[scenario];
    assert.ok(diagnosticOutput.includes(`phase=${failurePhase ?? 'CALLBACK_HANDLING'} result=${rejected ? 'FAIL' : 'OK'}`));
    assert.ok(diagnosticOutput.includes(`phase=CAPTURE_RESULT result=${rejected ? 'FAIL' : 'OK'}`));
    check = `${scenario}:delivery`;
    assert.equal(delivered, rejected ? 0 : 1, `${scenario}: delivery`);
    assert.equal(failures, rejected ? 1 : 0, `${scenario}: failure notification`);
    assert.equal(exchanges, ['unknown-origin', 'request-state'].includes(scenario) ? 0 : 1, `${scenario}: validated before exchange`);
    assert.equal(forbiddenRequests, 0, `${scenario}: forbidden destination requested`);
    assert.equal(page.url(), `${proxy}/isolated-qa-auth-complete`, `${scenario}: clean address`);
    check = `${scenario}:history-and-console`;
    const cdp = await context.newCDPSession(page);
    const history = JSON.stringify(await cdp.send('Page.getNavigationHistory'));
    for (const value of [sentinel, code, state, encodedState, 'callback_uri']) {
      assert.equal(history.includes(value), false, `${scenario}: history leak`);
      assert.equal(messages.some(message => message.includes(value)), false, `${scenario}: console leak`);
      assert.equal(diagnosticOutput.includes(value), false, `${scenario}: diagnostic leak`);
    }
    await cdp.detach();
    await page.close();
    process.stdout.write(`PASS: ${scenario}; callback isolated, clean history, no forbidden request.\n`);
  }
  await browser.close();
  assert.equal(context.browser().isConnected(), false);
  await assert.rejects(stat(browser.profile), { code: 'ENOENT' });
  process.stdout.write('PASS: normal Chrome closed and disposable profile removed.\n');
} catch {
  process.stderr.write(`FAIL: ${check} (details redacted).\n`); process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of servers) await new Promise(resolve => server.close(resolve));
}

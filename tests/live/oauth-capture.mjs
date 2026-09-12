// Playwright route() skips HTTP redirect hops. Use CDP on this owned sign-in page.
const phases = new Set(['CLIENT_PREPARE', 'CLIENT_LAUNCH', 'CLIENT_READY', 'CONNECT_WAIT', 'AUTH_START_VALIDATION', 'BROWSER_START', 'CAPTURE_INSTALL', 'AUTH_NAVIGATION', 'CAPTURE_WAIT', 'CALLBACK_REQUEST', 'CALLBACK_STATE', 'PROXY_EXCHANGE', 'PROXY_RESPONSE', 'CALLBACK_IDENTITY', 'CALLBACK_HANDLING', 'CLEAN_REDIRECT', 'COMPLETION_RENDER', 'COMPLETION_LOAD', 'COMPLETION_RELOAD', 'HISTORY_RESET', 'CAPTURE_RESULT', 'TOKEN_CHECK', 'BROWSER_CLOSE', 'CLIENT_HANDOFF', 'AUTH_TIMEOUT', 'AUTH_PAGE_CLOSED', 'ACCOUNT_PROOF', 'STAGE_EXECUTION']);
const results = new Set(['START', 'OK', 'FAIL']);

export function createAuthCheckpointReporter(client, write = text => process.stdout.write(text)) {
  return (phase, result) => {
    if (!Number.isInteger(client) || client < 1 || client > 3 || !phases.has(phase) || !results.has(result)) return;
    write(`QA_AUTH client=${client} phase=${phase} result=${result}\n`);
  };
}

export async function installOAuthCapture(page, options) {
  const origin = new URL(options.proxyOrigin).origin;
  const completion = `${origin}/isolated-qa-auth-complete`;
  const cdp = await page.context().newCDPSession(page);
  const controller = new AbortController();
  let success = false, claimed = false, finishing = false, settled = false, reported = false, shuttingDown = false, failureLogged = false;
  let phase = 'CAPTURE_INSTALL';
  const checkpoint = (code, result) => {
    if (!phases.has(code) || !results.has(result)) return;
    try { options.onCheckpoint?.(code, result); } catch { /* Diagnostics cannot alter auth. */ }
  };
  const mark = code => { phase = code; checkpoint(code, 'START'); };
  const step = async (code, work) => {
    mark(code);
    try { const result = await work(); checkpoint(code, 'OK'); return result; }
    catch { failureLogged = true; checkpoint(code, 'FAIL'); throw new Error('Isolated capture operation failed'); }
  };
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const settle = value => {
    if (settled) return;
    settled = true; clearTimeout(timer); checkpoint('CAPTURE_RESULT', value ? 'OK' : 'FAIL'); resolveFinished(value);
  };
  const notifyFailure = async () => {
    if (reported) return;
    reported = true;
    if (!failureLogged) { failureLogged = true; checkpoint(phase, 'FAIL'); }
    try { await options.onFailure?.('Isolated sign-in failed safely. Retry from the isolated client.'); } catch { /* Redact callback failures. */ }
  };
  const stop = async () => {
    shuttingDown = true;
    controller.abort();
    await notifyFailure();
    await page.close().catch(() => undefined);
    settle(false);
  };
  const timer = setTimeout(() => { mark('AUTH_TIMEOUT'); void stop(); }, options.timeoutMs ?? 600000);
  page.once('close', () => {
    if (!settled && !shuttingDown) checkpoint('AUTH_PAGE_CLOSED', 'FAIL');
    controller.abort(); settle(false);
  });
  const redirectClean = requestId => cdp.send('Fetch.fulfillRequest', {
    requestId, responseCode: 303,
    responseHeaders: [{ name: 'Location', value: completion }, { name: 'Cache-Control', value: 'no-store' }], body: '',
  });
  const handle = async ({ requestId, request }) => {
    const url = new URL(request.url);
    if (url.href === completion) {
      await step('COMPLETION_RENDER', () => cdp.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Cache-Control', value: 'no-store' }],
        body: Buffer.from(success
          ? '<!doctype html><title>Isolated sign-in complete</title><p>Credentials were delivered only to the isolated test client. You may close this window.</p>'
          : '<!doctype html><title>Isolated sign-in failed</title><p>Sign-in was rejected safely. Return to the isolated test client.</p>').toString('base64'),
      }));
      if (!finishing) {
        finishing = true;
        // Replace the owned tab's typed-navigation entry, then discard its prior
        // session history. This does not claim to erase all browser persistence.
        await step('COMPLETION_LOAD', () => page.waitForURL(completion, { waitUntil: 'load', timeout: 10000 }));
        await step('COMPLETION_RELOAD', () => page.goto(completion, { waitUntil: 'load', timeout: 10000 }));
        await step('HISTORY_RESET', () => cdp.send('Page.resetNavigationHistory'));
        settle(success);
      }
      return;
    }
    let response;
    try {
      mark('CALLBACK_REQUEST');
      if (claimed || url.origin !== origin || url.pathname !== '/api/auth/callback' || request.method !== 'GET' || url.username || url.password) throw new Error('Invalid callback request');
      checkpoint('CALLBACK_REQUEST', 'OK');
      claimed = true;
      // Matches the current proxy's encodeOAuthState(state, 'geode') contract.
      mark('CALLBACK_STATE');
      const encodedState = url.searchParams.get('state');
      const state = JSON.parse(Buffer.from(encodedState ?? '', 'base64url').toString('utf8'));
      if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code') || state.callbackApp !== 'geode' || state.state !== options.expectedState) throw new Error('Invalid callback state');
      checkpoint('CALLBACK_STATE', 'OK');
      response = await step('PROXY_EXCHANGE', () => fetch(url.href, { redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) }));
      mark('PROXY_RESPONSE');
      if (![302, 303, 307, 308].includes(response.status)) throw new Error('Invalid callback response');
      const location = new URL(response.headers.get('location'), origin);
      if (location.origin !== origin || location.pathname !== '/auth/success') throw new Error('Invalid callback destination');
      checkpoint('PROXY_RESPONSE', 'OK');
      mark('CALLBACK_IDENTITY');
      const uri = new URL(location.searchParams.get('callback_uri'));
      const params = Object.fromEntries(uri.searchParams);
      if (uri.protocol !== 'geode:' || uri.hostname !== 'gdocs-sync' || params.event !== 'auth_complete' || params.state !== options.expectedState || !params.access_token || !params.refresh_token) throw new Error('Invalid callback identity');
      checkpoint('CALLBACK_IDENTITY', 'OK');
      await step('CALLBACK_HANDLING', () => options.onCallback(params));
      success = true;
    } catch {
      success = false;
      await notifyFailure();
    } finally {
      await response?.body?.cancel().catch(() => undefined);
    }
    // No upstream token-bearing Location reaches Chromium, even on rejection.
    await step('CLEAN_REDIRECT', () => redirectClean(requestId));
  };
  cdp.on('Fetch.requestPaused', event => { void handle(event).catch(stop); });
  try {
    mark('CAPTURE_INSTALL');
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await cdp.send('Fetch.enable', { patterns: [
      { urlPattern: '*://*/api/auth/callback*', requestStage: 'Request' },
      { urlPattern: '*://*/auth/success*', requestStage: 'Request' },
      { urlPattern: completion, requestStage: 'Request' },
    ] });
    checkpoint('CAPTURE_INSTALL', 'OK');
  } catch {
    await stop();
    throw new Error('Isolated callback capture could not be installed');
  }
  return { finished };
}

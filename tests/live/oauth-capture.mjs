// Playwright route() skips HTTP redirect hops. Use CDP on this owned sign-in page.
export async function installOAuthCapture(page, options) {
  const origin = new URL(options.proxyOrigin).origin;
  const completion = `${origin}/isolated-qa-auth-complete`;
  const cdp = await page.context().newCDPSession(page);
  const controller = new AbortController();
  let success = false, claimed = false, finishing = false, settled = false, reported = false;
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const settle = value => {
    if (settled) return;
    settled = true; clearTimeout(timer); resolveFinished(value);
  };
  const notifyFailure = async () => {
    if (reported) return;
    reported = true;
    try { await options.onFailure?.('Isolated sign-in failed safely. Retry from the isolated client.'); } catch { /* Redact callback failures. */ }
  };
  const stop = async () => {
    controller.abort();
    await notifyFailure();
    await page.close().catch(() => undefined);
    settle(false);
  };
  const timer = setTimeout(() => { void stop(); }, options.timeoutMs ?? 600000);
  page.once('close', () => { controller.abort(); settle(false); });
  const redirectClean = requestId => cdp.send('Fetch.fulfillRequest', {
    requestId, responseCode: 303,
    responseHeaders: [{ name: 'Location', value: completion }, { name: 'Cache-Control', value: 'no-store' }], body: '',
  });
  const handle = async ({ requestId, request }) => {
    const url = new URL(request.url);
    if (url.href === completion) {
      await cdp.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Cache-Control', value: 'no-store' }],
        body: Buffer.from(success
          ? '<!doctype html><title>Isolated sign-in complete</title><p>Credentials were delivered only to the isolated test client. You may close this window.</p>'
          : '<!doctype html><title>Isolated sign-in failed</title><p>Sign-in was rejected safely. Return to the isolated test client.</p>').toString('base64'),
      });
      if (!finishing) {
        finishing = true;
        // Replace the owned tab's typed-navigation entry, then discard its prior
        // session history. This does not claim to erase all browser persistence.
        await page.waitForURL(completion, { waitUntil: 'load', timeout: 10000 });
        await page.goto(completion, { waitUntil: 'load', timeout: 10000 });
        await cdp.send('Page.resetNavigationHistory');
        settle(success);
      }
      return;
    }
    let response;
    try {
      if (claimed || url.origin !== origin || url.pathname !== '/api/auth/callback' || request.method !== 'GET' || url.username || url.password) throw new Error('Invalid callback request');
      claimed = true;
      // Matches the current proxy's encodeOAuthState(state, 'geode') contract.
      const encodedState = url.searchParams.get('state');
      const state = JSON.parse(Buffer.from(encodedState ?? '', 'base64url').toString('utf8'));
      if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code') || state.callbackApp !== 'geode' || state.state !== options.expectedState) throw new Error('Invalid callback state');
      response = await fetch(url.href, { redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      if (![302, 303, 307, 308].includes(response.status)) throw new Error('Invalid callback response');
      const location = new URL(response.headers.get('location'), origin);
      if (location.origin !== origin || location.pathname !== '/auth/success') throw new Error('Invalid callback destination');
      const uri = new URL(location.searchParams.get('callback_uri'));
      const params = Object.fromEntries(uri.searchParams);
      if (uri.protocol !== 'geode:' || uri.hostname !== 'gdocs-sync' || params.event !== 'auth_complete' || params.state !== options.expectedState || !params.access_token || !params.refresh_token) throw new Error('Invalid callback identity');
      await options.onCallback(params);
      success = true;
    } catch {
      success = false;
      await notifyFailure();
    } finally {
      await response?.body?.cancel().catch(() => undefined);
    }
    // No upstream token-bearing Location reaches Chromium, even on rejection.
    await redirectClean(requestId);
  };
  cdp.on('Fetch.requestPaused', event => { void handle(event).catch(stop); });
  try {
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await cdp.send('Fetch.enable', { patterns: [
      { urlPattern: '*://*/api/auth/callback*', requestStage: 'Request' },
      { urlPattern: '*://*/auth/success*', requestStage: 'Request' },
      { urlPattern: completion, requestStage: 'Request' },
    ] });
  } catch {
    await stop();
    throw new Error('Isolated callback capture could not be installed');
  }
  return { finished };
}

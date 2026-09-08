export async function installOAuthCapture(context, options) {
  const origin = new URL(options.proxyOrigin).origin;
  const completion = `${origin}/isolated-qa-auth-complete`;
  await context.route(`${origin}/api/auth/callback?*`, async route => {
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      if (![302, 303, 307, 308].includes(response.status())) throw new Error('Invalid callback response');
      const location = new URL(response.headers().location, origin);
      if (location.origin !== origin || location.pathname !== '/auth/success') throw new Error('Invalid callback destination');
      const uri = new URL(location.searchParams.get('callback_uri'));
      const params = Object.fromEntries(uri.searchParams);
      if (uri.protocol !== 'geode:' || uri.hostname !== 'gdocs-sync' || params.event !== 'auth_complete' || params.state !== options.expectedState || !params.access_token || !params.refresh_token) throw new Error('Invalid callback identity');
      await options.onCallback(params);
      // The token-bearing Location is never handed to Chromium or an OS protocol handler.
      await route.fulfill({ status: 303, headers: { location: completion, 'cache-control': 'no-store' }, body: '' });
    } catch {
      try { await options.onFailure?.('Isolated sign-in failed safely. Retry from the isolated client.'); } catch { /* Never expose callback errors or credential-bearing context. */ }
      await route.abort().catch(() => undefined);
    } finally { await response?.dispose().catch(() => undefined); }
  });
  await context.route(completion, route => route.fulfill({ status: 200, contentType: 'text/html', headers: { 'cache-control': 'no-store' }, body: '<!doctype html><title>Isolated sign-in complete</title><p>Credentials were delivered only to the isolated test client. You may close this window.</p>' }));
}

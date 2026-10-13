import { describe, expect, it, vi } from 'vitest';
import { getGeodeHostMarker, openAuthUrl } from '../../src/auth/openAuthUrl';
import { isGeodeHost } from '../../src/auth/GoogleAuth';

const URL_TO_OPEN = 'https://auth.example/api/auth/start?state=abc';

describe('openAuthUrl', () => {
  it('uses the Electron shell when available (desktop keeps the default browser profile)', () => {
    const openExternal = vi.fn();
    const open = vi.fn();
    openAuthUrl(URL_TO_OPEN, { require: () => ({ shell: { openExternal } }), open });
    expect(openExternal).toHaveBeenCalledWith(URL_TO_OPEN);
    expect(open).not.toHaveBeenCalled();
  });

  it('falls back to window.open when window.require is absent (mobile)', () => {
    const open = vi.fn();
    openAuthUrl(URL_TO_OPEN, { open });
    expect(open).toHaveBeenCalledWith(URL_TO_OPEN, '_blank');
  });

  it('falls back to window.open when require exists but electron is not resolvable', () => {
    const open = vi.fn();
    openAuthUrl(URL_TO_OPEN, { require: () => { throw new Error("Cannot find module 'electron'"); }, open });
    expect(open).toHaveBeenCalledWith(URL_TO_OPEN, '_blank');
  });

  it('falls back when electron resolves without a shell', () => {
    const open = vi.fn();
    openAuthUrl(URL_TO_OPEN, { require: () => ({}), open });
    expect(open).toHaveBeenCalledWith(URL_TO_OPEN, '_blank');
  });

  it('reports a clear error (not a TypeError) when nothing can open a browser', () => {
    expect(() => openAuthUrl(URL_TO_OPEN, {})).toThrow(/No way to open the browser/);
  });
});

describe('getGeodeHostMarker', () => {
  it('reads the same window.geode.host marker on mobile as on desktop', () => {
    const host = { name: 'geode', protocolScheme: 'geode' };
    const marker = getGeodeHostMarker({ geode: { host } });
    expect(isGeodeHost(marker)).toBe(true);
  });

  it('returns undefined on a non-Geode host', () => {
    expect(getGeodeHostMarker({})).toBeUndefined();
  });
});

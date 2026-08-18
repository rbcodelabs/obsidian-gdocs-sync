import { describe, expect, it } from 'vitest';
import { buildConnectUrl, isGeodeHost } from '../../src/auth/GoogleAuth';

describe('GoogleAuth host callback selection', () => {
  it('requests the Geode callback only for the explicit Geode host marker', () => {
    const host = { name: 'geode', protocolScheme: 'geode' };
    expect(isGeodeHost(host)).toBe(true);
    expect(buildConnectUrl('https://auth.example', 'state value', host)).toBe(
      'https://auth.example/api/auth/start?state=state%20value&callback_app=geode',
    );
  });

  it('retains the Obsidian flow without the explicit marker', () => {
    expect(isGeodeHost(undefined)).toBe(false);
    expect(buildConnectUrl('https://auth.example', 'state value', undefined)).toBe(
      'https://auth.example/api/auth/start?state=state%20value',
    );
  });
});

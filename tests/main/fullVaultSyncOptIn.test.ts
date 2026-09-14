import { describe, expect, it, vi } from 'vitest';
import GDocsPlugin, { FULL_VAULT_SYNC_OPT_IN_PENDING } from '../../src/main';
import { DEFAULT_SETTINGS } from '../../src/types';

/**
 * Builds a GDocsPlugin without running onload() — just the fields the full
 * vault sync gate reads — so the opt-in decision can be exercised without
 * standing up the whole plugin (auth, sync engines, status bar, commands).
 */
function fakePlugin(options: { fullVaultSyncEnabled?: boolean; secureStorage?: boolean; geodeHost?: boolean } = {}) {
  const { fullVaultSyncEnabled = false, secureStorage = true, geodeHost = true } = options;
  const plugin = Object.create(GDocsPlugin.prototype) as GDocsPlugin;
  Object.assign(plugin, {
    settings: { ...DEFAULT_SETTINGS, fullVaultSyncEnabled },
    tokenStore: { hasSecureStorage: () => secureStorage },
    fullVaultSyncUnavailable: FULL_VAULT_SYNC_OPT_IN_PENDING,
    fullVaultSyncBlocked: '',
    fullVaultSyncRegistered: false,
    fullVaultSyncWarnings: [] as string[],
  });
  if (geodeHost) {
    Object.assign(plugin, {
      registerSyncProvider: vi.fn(), loadDeviceState: vi.fn(), saveDeviceState: vi.fn(),
      loadSecret: vi.fn(), saveSecret: vi.fn(), removeSecret: vi.fn(),
    });
  }
  return plugin as GDocsPlugin & { registerSyncProvider: ReturnType<typeof vi.fn> };
}

describe('full vault sync opt-in', () => {
  it('ships off by default', () => {
    expect(DEFAULT_SETTINGS.fullVaultSyncEnabled).toBe(false);
  });

  it('does not register the transport when the user has not opted in', () => {
    const plugin = fakePlugin({ fullVaultSyncEnabled: false });
    plugin.initFullVaultSync();
    expect(plugin.registerSyncProvider).not.toHaveBeenCalled();
    expect(plugin.fullVaultSyncRegistered).toBe(false);
    expect(plugin.fullVaultSyncUnavailable).toBe(FULL_VAULT_SYNC_OPT_IN_PENDING);
  });

  it('registers the transport when the user has opted in', () => {
    const plugin = fakePlugin({ fullVaultSyncEnabled: true });
    plugin.initFullVaultSync();
    expect(plugin.registerSyncProvider).toHaveBeenCalledTimes(1);
    expect(plugin.registerSyncProvider.mock.calls[0][0].protocol).toBe('append-only-history-v1');
    expect(plugin.fullVaultSyncRegistered).toBe(true);
    // The settings tab renders this empty string as "registered".
    expect(plugin.fullVaultSyncUnavailable).toBe('');
  });

  it('registers on demand when the user opts in after load', () => {
    const plugin = fakePlugin({ fullVaultSyncEnabled: false });
    plugin.initFullVaultSync();
    expect(plugin.registerSyncProvider).not.toHaveBeenCalled();

    plugin.settings.fullVaultSyncEnabled = true;
    expect(plugin.registerFullVaultSync()).toBe(true);
    expect(plugin.registerSyncProvider).toHaveBeenCalledTimes(1);
    expect(plugin.fullVaultSyncUnavailable).toBe('');
  });

  it('is idempotent — Geode has no in-process unregister, so never double-register', () => {
    const plugin = fakePlugin({ fullVaultSyncEnabled: true });
    expect(plugin.registerFullVaultSync()).toBe(true);
    expect(plugin.registerFullVaultSync()).toBe(true);
    expect(plugin.registerSyncProvider).toHaveBeenCalledTimes(1);
  });

  it('lets a hard host block win over the opt-in', () => {
    const plugin = fakePlugin({ fullVaultSyncEnabled: true });
    plugin.fullVaultSyncBlocked = 'Secure secret storage is unavailable.';
    plugin.initFullVaultSync();
    expect(plugin.registerSyncProvider).not.toHaveBeenCalled();
    expect(plugin.fullVaultSyncUnavailable).toBe('Secure secret storage is unavailable.');
  });

  it('reports the reason and stays unregistered when registration throws', () => {
    const plugin = fakePlugin({ fullVaultSyncEnabled: true, secureStorage: false });
    expect(plugin.registerFullVaultSync()).toBe(false);
    expect(plugin.registerSyncProvider).not.toHaveBeenCalled();
    expect(plugin.fullVaultSyncRegistered).toBe(false);
    expect(plugin.fullVaultSyncUnavailable).toMatch(/Geode/);
  });

  it('collects discovery warnings without duplicating them', () => {
    const plugin = fakePlugin({ fullVaultSyncEnabled: true });
    plugin.registerFullVaultSync();
    // The callback main.ts wires up is reachable only through the provider's config.
    const { config } = plugin.registerSyncProvider.mock.calls[0][0] as { config: { onDiscoveryIssue(issue: { rootId: string; message: string }): void } };
    config.onDiscoveryIssue({ rootId: 'root', message: 'two vault folders found' });
    config.onDiscoveryIssue({ rootId: 'root', message: 'two vault folders found' });
    expect(plugin.fullVaultSyncWarnings).toEqual(['two vault folders found']);
  });
});

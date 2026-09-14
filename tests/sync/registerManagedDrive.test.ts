import { describe, expect, it, vi } from 'vitest';
import { registerManagedDrive } from '../../src/sync/registerManagedDrive';
import { DEFAULT_SETTINGS } from '../../src/types';

describe('gated managed Drive integration', () => {
  it('uses plugin-owned registration, device state, secrets and visible exclusions', async () => {
    const plugin = { registerSyncProvider: vi.fn(), loadDeviceState: vi.fn(), saveDeviceState: vi.fn(), loadSecret: vi.fn(), saveSecret: vi.fn(), removeSecret: vi.fn() };
    registerManagedDrive(plugin as never, { hasSecureStorage: () => true } as never, () => DEFAULT_SETTINGS, JSON.parse, vi.fn());
    const provider = plugin.registerSyncProvider.mock.calls[0][0];
    expect(provider.protocol).toBe('append-only-history-v1'); expect(provider.capabilities.conditionalWrites).toBe(false);
    expect(await provider.excludePath(`${DEFAULT_SETTINGS.tasksFolder}/task.md`)).toContain('Google Tasks');
  });
  it('fails before registration on ordinary Obsidian or unavailable secure storage', () => {
    expect(() => registerManagedDrive({} as never, { hasSecureStorage: () => false } as never, () => DEFAULT_SETTINGS, JSON.parse, vi.fn())).toThrow(/Geode/);
  });
});

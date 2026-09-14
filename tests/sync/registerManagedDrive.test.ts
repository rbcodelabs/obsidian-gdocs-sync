import { describe, expect, it, vi } from 'vitest';
import { managedDriveUnavailableReason, registerManagedDrive } from '../../src/sync/registerManagedDrive';
import { DEFAULT_SETTINGS } from '../../src/types';

const geodeHost = () => ({ registerSyncProvider: vi.fn(), loadDeviceState: vi.fn(), saveDeviceState: vi.fn(), loadSecret: vi.fn(), saveSecret: vi.fn(), removeSecret: vi.fn() });

describe('managedDriveUnavailableReason', () => {
  it('reports no reason on a Geode host with secure storage', () => {
    expect(managedDriveUnavailableReason(geodeHost() as never, { hasSecureStorage: () => true } as never)).toBe('');
  });
  it('reports a reason when secure storage is unavailable', () => {
    const reason = managedDriveUnavailableReason(geodeHost() as never, { hasSecureStorage: () => false } as never);
    expect(reason).not.toBe(''); expect(reason).toMatch(/secure/i); expect(reason).toMatch(/Geode/);
  });
  it('reports a reason on ordinary Obsidian, which lacks the plugin-owned Geode methods', () => {
    const reason = managedDriveUnavailableReason({} as never, { hasSecureStorage: () => true } as never);
    expect(reason).not.toBe(''); expect(reason).toMatch(/Geode/);
  });
  it('reports a reason when any single required method is missing', () => {
    for (const missing of ['registerSyncProvider', 'loadDeviceState', 'saveDeviceState', 'loadSecret', 'saveSecret', 'removeSecret']) {
      const host = geodeHost() as Record<string, unknown>;
      delete host[missing];
      expect(managedDriveUnavailableReason(host as never, { hasSecureStorage: () => true } as never)).not.toBe('');
    }
  });
});

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

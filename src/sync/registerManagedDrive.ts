import type { Plugin } from 'obsidian';
import type { GDocsPluginSettings } from '../types';
import type { TokenStore } from '../auth/TokenStore';
import { GoogleDriveSyncProvider } from './GoogleDriveSyncProvider';
import { managedPathExclusion } from './managedPathExclusion';

/**
 * Plugin-owned host methods the managed Drive transport needs. Ordinary
 * Obsidian provides none of them; only a current Geode build does.
 */
const REQUIRED_HOST_METHODS = ['registerSyncProvider', 'loadDeviceState', 'saveDeviceState', 'loadSecret', 'saveSecret', 'removeSecret'] as const;

/**
 * Hard capability check for the managed Drive transport, independent of whether
 * the user has opted in. Returns '' when the host can support it, otherwise a
 * human-readable reason suitable for display in the settings tab.
 */
export function managedDriveUnavailableReason(plugin: Plugin, tokens: TokenStore): string {
  if (!tokens.hasSecureStorage()) return 'Full vault sync requires Geode secure secret storage, which is unavailable on this device.';
  const host = plugin as unknown as Record<string, unknown>;
  if (REQUIRED_HOST_METHODS.some(method => typeof host[method] !== 'function')) return 'Full vault sync requires Geode; this host does not provide plugin-owned sync registration, device state and secret storage.';
  return '';
}

export function registerManagedDrive(plugin: Plugin, tokens: TokenStore, settings: () => GDocsPluginSettings, parseYaml: (value: string) => unknown, issue: (message: string) => void): void {
  const unavailable = managedDriveUnavailableReason(plugin, tokens);
  if (unavailable) throw new Error(unavailable);
  plugin.registerSyncProvider(new GoogleDriveSyncProvider(tokens, {
    loadDeviceState: key => plugin.loadDeviceState(key), saveDeviceState: (key, value) => plugin.saveDeviceState(key, value),
    loadSecret: key => plugin.loadSecret(key), saveSecret: (key, value) => plugin.saveSecret(key, value), removeSecret: key => plugin.removeSecret(key),
    excludePath: (path, data) => managedPathExclusion(path, data, settings(), parseYaml),
    onDiscoveryIssue: warning => issue(warning.message),
  }));
}

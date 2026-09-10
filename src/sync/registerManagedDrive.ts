import type { Plugin } from 'obsidian';
import type { GDocsPluginSettings } from '../types';
import type { TokenStore } from '../auth/TokenStore';
import { GoogleDriveSyncProvider } from './GoogleDriveSyncProvider';
import { managedPathExclusion } from './managedPathExclusion';
export function registerManagedDrive(plugin: Plugin, tokens: TokenStore, settings: () => GDocsPluginSettings, parseYaml: (value: string) => unknown, issue: (message: string) => void): void {
  if (!tokens.hasSecureStorage() || ['registerSyncProvider', 'loadDeviceState', 'saveDeviceState', 'loadSecret', 'saveSecret', 'removeSecret'].some(method => typeof (plugin as unknown as Record<string, unknown>)[method] !== 'function')) throw new Error('Managed vault sync requires current Geode device state and secure storage');
  plugin.registerSyncProvider(new GoogleDriveSyncProvider(tokens, {
    loadDeviceState: key => plugin.loadDeviceState(key), saveDeviceState: (key, value) => plugin.saveDeviceState(key, value),
    loadSecret: key => plugin.loadSecret(key), saveSecret: (key, value) => plugin.saveSecret(key, value), removeSecret: key => plugin.removeSecret(key),
    excludePath: (path, data) => managedPathExclusion(path, data, settings(), parseYaml),
    onDiscoveryIssue: warning => issue(warning.message),
  }));
}

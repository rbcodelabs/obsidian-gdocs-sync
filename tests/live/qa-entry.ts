import GDocsPlugin from '../../src/main';
import { GoogleAuth } from '../../src/auth/GoogleAuth';
import type { AppendOnlySyncProvider, SyncProvider } from 'geode';

/** Separate disposable-only build. This entry is never part of the production artifact. */
export default class ManagedDriveQAPlugin extends GDocsPlugin {
  qaAuthUrl: string | null = null;
  qaProvider?: AppendOnlySyncProvider;
  registerSyncProvider(provider: SyncProvider | AppendOnlySyncProvider): void {
    if ('protocol' in provider && provider.protocol === 'append-only-history-v1') this.qaProvider = provider;
    super.registerSyncProvider(provider);
  }
  /**
   * The acceptance runner must always get a provider registered. Force the
   * opt-in on before onload() reads it, instead of driving the consent UI.
   */
  async loadSettings(): Promise<void> {
    await super.loadSettings();
    this.settings.fullVaultSyncEnabled = true;
  }
  async onload(): Promise<void> {
    await super.onload();
    this.syncEngine.stop(); this.tasksSyncEngine.stop();
    // Never send QA auth to the OS/default browser. A dedicated driver consumes this URL in memory.
    this.auth = new GoogleAuth(this, this.tokenStore, async url => { this.qaAuthUrl = url; });
    this.connectionApi = this.auth;
    this.auth.onConnectionChange(() => this.settingsTab.display());
  }
}

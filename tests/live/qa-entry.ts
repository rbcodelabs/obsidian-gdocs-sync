import GDocsPlugin from '../../src/main';
import { GoogleAuth } from '../../src/auth/GoogleAuth';

/** Separate disposable-only build. This entry is never part of the production artifact. */
export default class ManagedDriveQAPlugin extends GDocsPlugin {
  qaAuthUrl: string | null = null;
  async onload(): Promise<void> {
    await super.onload();
    this.syncEngine.stop(); this.tasksSyncEngine.stop();
    // Never send QA auth to the OS/default browser. A dedicated driver consumes this URL in memory.
    this.auth = new GoogleAuth(this, this.tokenStore, async url => { this.qaAuthUrl = url; });
    this.auth.onConnected = () => this.settingsTab.display();
  }
}

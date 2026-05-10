import { GoogleDocsAPI } from '../api/GoogleDocsAPI';

export class GDocsPoller {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private syncedDocs: Map<string, string> = new Map(); // docId → last known revision

  constructor(
    private api: GoogleDocsAPI,
    private onRemoteChange: (docId: string) => Promise<void>,
    private intervalSeconds: number,
  ) {}

  /**
   * Begin polling. The provided map is stored by reference so the SyncEngine
   * can keep it up-to-date as new docs are linked.
   *
   * @param syncedDocs - Map of docId → last known revision string
   */
  start(syncedDocs: Map<string, string>): void {
    this.syncedDocs = syncedDocs;

    if (this.intervalId !== null) {
      // Already running — update interval
      this.stop();
    }

    this.intervalId = setInterval(
      () => void this.poll(),
      this.intervalSeconds * 1000,
    );
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Check every tracked document for remote changes.
   * Called automatically by the interval, but can also be called manually.
   */
  async poll(): Promise<void> {
    const checks: Array<Promise<void>> = [];

    for (const [docId, knownRevision] of this.syncedDocs.entries()) {
      checks.push(this.checkDoc(docId, knownRevision));
    }

    // Run all checks concurrently but swallow individual errors so one bad
    // document doesn't stop others from being polled.
    await Promise.allSettled(checks);
  }

  private async checkDoc(docId: string, knownRevision: string): Promise<void> {
    try {
      const latestRevision = await this.api.getDocumentRevision(docId);

      if (latestRevision !== knownRevision) {
        // Update stored revision immediately to avoid firing the callback twice
        // if the next poll arrives before the sync completes.
        this.syncedDocs.set(docId, latestRevision);
        await this.onRemoteChange(docId);
      }
    } catch (err) {
      // Log but do not rethrow — polling errors are non-fatal
      console.error(`[GDocsPoller] Error checking doc ${docId}:`, err);
    }
  }
}

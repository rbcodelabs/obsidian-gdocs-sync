/**
 * Interval poller for Google Tasks. A thin wrapper that fires a provided
 * reconciliation function on a timer — all the incremental logic (per-list
 * updatedMin tracking, note upserts, deletions) lives in TasksSyncEngine.poll,
 * mirroring how FolderPoller delegates to importFolder.
 */
export class TasksPoller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pollFn: () => Promise<void>,
    private intervalSeconds: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.pollFn(),
      this.intervalSeconds * 1000,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one reconciliation pass immediately (e.g. on plugin start). */
  async runNow(): Promise<void> {
    await this.pollFn();
  }
}

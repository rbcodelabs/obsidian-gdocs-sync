// TODO: v2 — provide a diff/merge UI via a Modal that shows a side-by-side diff
// of local vs remote content, letting the user choose which side wins (or manually
// merge). Consider using diff-match-patch for three-way merging.

export type ConflictSide = 'local' | 'remote';

export class ConflictResolver {
  /**
   * Last-write-wins strategy: whichever side has the more recent modification
   * timestamp is considered authoritative.
   *
   * Ties (equal timestamps) resolve to 'local' to avoid unnecessary writes.
   */
  resolve(localModifiedAt: Date, remoteModifiedAt: Date): ConflictSide {
    return localModifiedAt >= remoteModifiedAt ? 'local' : 'remote';
  }
}

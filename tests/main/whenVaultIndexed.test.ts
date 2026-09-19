import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { METADATA_READY_TIMEOUT_MS, whenVaultIndexed } from '../../src/main';

/**
 * Fake App exposing just the two readiness hooks whenVaultIndexed() uses, with
 * manual triggers so a test can control exactly when each fires.
 */
function fakeApp() {
  let layoutReady: (() => void) | undefined;
  const resolvedListeners: Array<() => void> = [];
  const offref = vi.fn();

  const app = {
    workspace: {
      onLayoutReady: (cb: () => void) => {
        layoutReady = cb;
      },
    },
    metadataCache: {
      on: (event: string, cb: () => void) => {
        expect(event).toBe('resolved');
        resolvedListeners.push(cb);
        return { event, cb };
      },
      offref,
    },
  };

  return {
    app: app as unknown as App,
    offref,
    fireLayoutReady: () => layoutReady?.(),
    fireResolved: () => resolvedListeners.forEach((cb) => cb()),
    get subscribedBeforeLayoutReady() {
      return resolvedListeners.length;
    },
  };
}

/** Let any already-resolved promise continuations run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('whenVaultIndexed', () => {
  it('does not resolve before the layout is ready', async () => {
    const { app } = fakeApp();
    let done = false;
    void whenVaultIndexed(app).then(() => {
      done = true;
    });

    await flush();
    expect(done).toBe(false);
  });

  it('resolves once the metadata cache reports its initial scan resolved', async () => {
    const { app, offref, fireLayoutReady, fireResolved } = fakeApp();
    let done = false;
    const waiting = whenVaultIndexed(app).then(() => {
      done = true;
    });

    fireLayoutReady();
    await flush();
    expect(done).toBe(false); // layout ready alone is not enough

    fireResolved();
    await waiting;
    expect(done).toBe(true);
    expect(offref).toHaveBeenCalledTimes(1); // listener cleaned up
  });

  it('falls back to a timeout, because "resolved" never fires on an already-clean cache', async () => {
    vi.useFakeTimers();
    try {
      const { app, fireLayoutReady } = fakeApp();
      let done = false;
      void whenVaultIndexed(app, 50).then(() => {
        done = true;
      });

      fireLayoutReady();
      await vi.advanceTimersByTimeAsync(49);
      expect(done).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves only once when both the event and the timeout fire', async () => {
    vi.useFakeTimers();
    try {
      const { app, offref, fireLayoutReady, fireResolved } = fakeApp();
      const settled = vi.fn();
      void whenVaultIndexed(app, 50).then(settled);

      fireLayoutReady();
      fireResolved();
      await vi.advanceTimersByTimeAsync(100);
      fireResolved();
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toHaveBeenCalledTimes(1);
      expect(offref).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults to a bounded wait', () => {
    expect(METADATA_READY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(METADATA_READY_TIMEOUT_MS)).toBe(true);
  });
});

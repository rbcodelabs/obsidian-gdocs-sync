interface ElectronShell {
  openExternal(url: string): unknown;
}

interface HostWindow {
  require?: (id: string) => unknown;
  open?: (url: string, target?: string) => unknown;
  geode?: { host?: unknown };
}

/**
 * Open the OAuth URL in the user's default browser, on any host.
 *
 * Desktop (Obsidian/Geode on Electron): `shell.openExternal` keeps the user's
 * normal browser profile; `window.open()` there hands off to Chrome without
 * profile context, which opens an incognito window.
 *
 * Mobile (no Node, no Electron): `window.require` is absent, so fall back to
 * `window.open(url, '_blank')`. Both Obsidian mobile and Geode mobile route
 * that to the native external browser. Never throws because Electron is missing.
 */
export function openAuthUrl(url: string, win: HostWindow = window as unknown as HostWindow): void {
  const shell = getElectronShell(win);
  if (shell) {
    void shell.openExternal(url);
    return;
  }
  if (typeof win.open === 'function') {
    win.open(url, '_blank');
    return;
  }
  throw new Error('No way to open the browser on this host. Open this URL manually: ' + url);
}

function getElectronShell(win: HostWindow): ElectronShell | null {
  try {
    const electron = win.require?.('electron') as { shell?: ElectronShell } | undefined;
    return typeof electron?.shell?.openExternal === 'function' ? electron.shell : null;
  } catch {
    return null;
  }
}

/** The Geode host marker (`window.geode.host`), present on desktop and mobile Geode. */
export function getGeodeHostMarker(win: HostWindow = window as unknown as HostWindow): unknown {
  return win.geode?.host;
}

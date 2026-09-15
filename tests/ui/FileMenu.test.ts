import { describe, it, expect, vi } from 'vitest';
import { Menu, TFile } from 'obsidian';
import { registerFileMenuActions, FileMenuPluginLike } from '../../src/ui/FileMenu';

function makeTFile(path = 'Notes/Foo.md'): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = path.split('/').pop()!.replace(/\.md$/, '');
  f.extension = 'md';
  return f;
}

/** Builds a fake plugin and captures the registered 'file-menu' handler. */
function makePlugin(frontmatter?: Record<string, unknown>) {
  let handler: ((menu: Menu, file: unknown) => void) | undefined;

  const plugin: FileMenuPluginLike = {
    app: {
      workspace: {
        on: vi.fn((name: string, cb: (menu: Menu, file: unknown) => void) => {
          if (name === 'file-menu') handler = cb;
          return { name } as never;
        }),
      },
      metadataCache: {
        getFileCache: vi.fn(() => ({ frontmatter })),
      },
    } as never,
    registerEvent: vi.fn(),
    statusBar: {} as never,
    syncEngine: {} as never,
    perFileErrors: new Map(),
  };

  return {
    plugin,
    fire: (file: unknown) => {
      const menu = new Menu();
      handler!(menu, file);
      return menu;
    },
  };
}

describe('registerFileMenuActions', () => {
  it('registers a file-menu handler on the workspace', () => {
    const { plugin } = makePlugin();
    registerFileMenuActions(plugin);

    expect(plugin.app.workspace.on).toHaveBeenCalledWith('file-menu', expect.any(Function));
    expect(plugin.registerEvent).toHaveBeenCalled();
  });

  it('adds nothing for a non-markdown file', () => {
    const { plugin, fire } = makePlugin();
    registerFileMenuActions(plugin);

    const file = makeTFile('Attachments/photo.png');
    file.extension = 'png';
    const menu = fire(file);

    expect(menu.items).toHaveLength(0);
    expect(menu.separatorCount).toBe(0);
  });

  it('adds nothing for a folder (non-TFile)', () => {
    const { plugin, fire } = makePlugin();
    registerFileMenuActions(plugin);

    const folder = { path: 'Notes', children: [] };
    const menu = fire(folder);

    expect(menu.items).toHaveLength(0);
    expect(menu.separatorCount).toBe(0);
  });

  it('adds all three items for a linked markdown file', () => {
    const { plugin, fire } = makePlugin({ 'gdocs-id': 'doc123' });
    registerFileMenuActions(plugin);

    const file = makeTFile();
    const menu = fire(file);

    expect(menu.separatorCount).toBe(1);
    expect(menu.items.map((i) => i.title)).toEqual([
      'Sync to Google Docs',
      'Pull from Google Docs',
      'Open in Google Docs',
    ]);
    expect(menu.items[0].icon).toBe('upload-cloud');
    expect(menu.items[1].icon).toBe('download-cloud');
    expect(menu.items[2].icon).toBe('external-link');
  });

  it('adds only "Sync to Google Docs" for an unlinked markdown file', () => {
    const { plugin, fire } = makePlugin(undefined);
    registerFileMenuActions(plugin);

    const file = makeTFile();
    const menu = fire(file);

    expect(menu.separatorCount).toBe(1);
    expect(menu.items.map((i) => i.title)).toEqual(['Sync to Google Docs']);
  });
});

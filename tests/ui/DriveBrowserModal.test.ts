import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveBrowserModal } from '../../src/ui/DriveBrowserModal';

vi.mock('obsidian', () => {
  function decorate(el: HTMLElement): HTMLElement {
    Object.assign(el, {
      empty: () => el.replaceChildren(),
      addClass: (cls: string) => el.classList.add(cls),
      removeClass: (cls: string) => el.classList.remove(cls),
      createEl: (tag: string, options: { text?: string; cls?: string } = {}) => {
        const child = decorate(document.createElement(tag));
        child.textContent = options.text ?? '';
        child.className = options.cls ?? '';
        el.append(child);
        return child;
      },
      createDiv: (options: { cls?: string } = {}) => (el as any).createEl('div', options),
    });
    return el;
  }
  return {
    Modal: class {
      contentEl = decorate(document.createElement('div'));
      constructor() { document.body.append(this.contentEl); }
      setTitle() {}
      close() { (this as any).onClose(); }
    },
    Notice: vi.fn(),
    Setting: class {
      setName() { return this; }
      setDesc() { return this; }
      addText() { return this; }
    },
  };
});

const folder = (id: string, name: string) => ({ id, name, mimeType: 'application/vnd.google-apps.folder', modifiedTime: '' });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const row = (name: string) => [...document.querySelectorAll<HTMLElement>('.gdocs-drive-item')].find(el => el.textContent?.includes(name))!;
const api = { listSharedDrives: vi.fn(), listFolderContents: vi.fn() };
const select = vi.fn();
function open(mode: 'folder' | 'doc' = 'folder') {
  const modal = new DriveBrowserModal({} as never, { api } as never, mode, select);
  modal.onOpen();
  return modal;
}
beforeEach(() => {
  document.body.replaceChildren();
  vi.resetAllMocks();
  api.listSharedDrives.mockResolvedValue([{ id: 'team', name: 'Team Drive' }]);
  api.listFolderContents.mockResolvedValue([folder('child', 'Child')]);
});

describe('Drive browser navigation', () => {
  it('shows Shared Drives and My Drive and selects a root for sync', async () => {
    open(); await settle();
    expect(row('My Drive')).toBeDefined();
    row('Team Drive').click();
    [...document.querySelectorAll('button')].find(el => el.textContent === 'Sync This Folder')!.click();
    await settle();
    expect(select).toHaveBeenCalledWith(folder('team', 'Team Drive'), [], 'Team Drive');
  });

  it('keeps My Drive available when Shared Drives fail', async () => {
    api.listSharedDrives.mockRejectedValue(new Error('Unavailable'));
    open(); await settle();
    expect(row('My Drive')).toBeDefined();
    expect(document.querySelectorAll('.gdocs-drive-item')).toHaveLength(1);
  });

  it('navigates folders from the keyboard', async () => {
    open('doc'); await settle();
    expect(row('Team Drive').tabIndex).toBe(0);
    row('Team Drive').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(api.listFolderContents).toHaveBeenCalledWith('team');
    expect(row('Child')).toBeDefined();
  });

  it('keeps the clicked breadcrumb when returning from a nested folder', async () => {
    open('doc'); await settle();
    row('Team Drive').click(); await settle();
    api.listFolderContents.mockResolvedValue([]);
    row('Child').click(); await settle();
    [...document.querySelectorAll<HTMLElement>('.gdocs-crumb-link')].find(el => el.textContent === 'Team Drive')!.click();
    await settle();
    expect(document.querySelector('.gdocs-breadcrumbs')?.textContent).toBe('Drives › Team Drive');
  });

  it('ignores a folder response after the user returns to Drives', async () => {
    let resolve!: (items: unknown[]) => void;
    api.listFolderContents.mockReturnValue(new Promise(r => { resolve = r; }));
    open('doc'); await settle();
    row('Team Drive').click();
    document.querySelector<HTMLElement>('.gdocs-crumb-link')!.click(); await settle();
    resolve([folder('old', 'Stale folder')]); await settle();
    expect(row('My Drive')).toBeDefined();
    expect(row('Stale folder')).toBeUndefined();
  });

  it('does not offer stale rows when a folder request fails', async () => {
    api.listFolderContents.mockRejectedValue(new Error('Unavailable'));
    open('doc'); await settle();
    row('Team Drive').click(); await settle();
    expect(document.querySelectorAll('.gdocs-drive-item')).toHaveLength(0);
  });

  it('ignores requests that finish after the modal closes', async () => {
    let resolve!: (drives: unknown[]) => void;
    api.listSharedDrives.mockReturnValue(new Promise(r => { resolve = r; }));
    const modal = open(); modal.onClose();
    resolve([{ id: 'late', name: 'Late Drive' }]); await settle();
    expect(modal.contentEl.children).toHaveLength(0);
  });
});

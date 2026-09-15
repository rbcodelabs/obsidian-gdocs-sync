import { vi } from 'vitest';

// Minimal mock of the Obsidian API for unit tests.
// Only stubs the symbols actually imported by the files under test.
export class Notice {
  constructor(public message: string) {}
}
export class Plugin {}
export const requestUrl = vi.fn();
export class Modal {
  constructor(public app: unknown) {}
  open() {}
  close() {}
}
export class TFile {
  path = '';
  basename = '';
  extension = 'md';
  stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
}
export class Setting {
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addButton() { return this; }
  addToggle() { return this; }
  addDropdown() { return this; }
}
export class PluginSettingTab {}
export class ButtonComponent {
  setButtonText() { return this; }
  setCta() { return this; }
  setWarning() { return this; }
  onClick() { return this; }
}
export class TextComponent {
  inputEl = { focus: () => {} };
  setPlaceholder() { return this; }
  setValue() { return this; }
  onChange() { return this; }
}
export interface MockMenuItemRecord {
  title?: string;
  icon?: string;
  onClick?: (evt?: unknown) => unknown;
}
export class MenuItem {
  record: MockMenuItemRecord = {};
  setTitle(title: string) {
    this.record.title = title;
    return this;
  }
  setIcon(icon: string | null) {
    this.record.icon = icon ?? undefined;
    return this;
  }
  onClick(callback: (evt?: unknown) => unknown) {
    this.record.onClick = callback;
    return this;
  }
}
export class Menu {
  /** Flat record of every item added via addItem(), for test inspection. */
  items: MockMenuItemRecord[] = [];
  separatorCount = 0;
  addItem(cb: (item: MenuItem) => unknown) {
    const item = new MenuItem();
    cb(item);
    this.items.push(item.record);
    return this;
  }
  addSeparator() {
    this.separatorCount++;
    return this;
  }
}

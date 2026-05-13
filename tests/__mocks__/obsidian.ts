// Minimal mock of the Obsidian API for unit tests.
// Only stubs the symbols actually imported by the files under test.
export class Notice {
  constructor(public message: string) {}
}
export class Plugin {}
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

import { vi } from 'vitest';

// Minimal mock of the Obsidian API for unit tests.
// Only stubs the symbols actually imported by the files under test.
/**
 * Every Notice message constructed during a test run, newest last. Tests that
 * assert on user-visible notices can read (and reset) this.
 */
export const noticeLog: string[] = [];
export class Notice {
  constructor(public message: string) {
    noticeLog.push(message);
  }
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
export class MarkdownView {}
export class ButtonComponent {
  setButtonText() { return this; }
  setCta() { return this; }
  setWarning() { return this; }
  onClick() { return this; }
}
export class TextComponent {
  // A real <input> when a DOM exists (happy-dom), so view tests can type into it.
  inputEl: HTMLInputElement = (typeof document !== 'undefined'
    ? document.createElement('input')
    : ({ focus: () => {} } as unknown as HTMLInputElement));
  constructor(containerEl?: HTMLElement) {
    containerEl?.appendChild(this.inputEl);
  }
  setPlaceholder(v?: string) { if (v !== undefined) this.inputEl.placeholder = v; return this; }
  setValue(v?: string) { if (v !== undefined) this.inputEl.value = v; return this; }
  onChange() { return this; }
}
export class DropdownComponent {
  selectEl: HTMLSelectElement = document.createElement('select');
  constructor(containerEl?: HTMLElement) {
    containerEl?.appendChild(this.selectEl);
  }
  addOption(value: string, display: string) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = display;
    this.selectEl.appendChild(o);
    return this;
  }
  setValue(value: string) { this.selectEl.value = value; return this; }
  getValue() { return this.selectEl.value; }
  onChange(cb: (value: string) => unknown) {
    this.selectEl.addEventListener('change', () => cb(this.selectEl.value));
    return this;
  }
}
export class WorkspaceLeaf {}
export function setIcon(el: HTMLElement, iconId: string) {
  el.setAttribute('data-icon', iconId);
}

// Obsidian augments HTMLElement with these helpers; install minimal versions so
// views that call createEl/createDiv/empty/addClass can run under happy-dom.
type ElOpts = { text?: string; cls?: string | string[]; attr?: Record<string, string>; type?: string; placeholder?: string };
function installDomHelpers() {
  if (typeof HTMLElement === 'undefined') return;
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (proto.createEl) return;
  proto.createEl = function (this: HTMLElement, tag: string, o: ElOpts | string = {}) {
    const opts: ElOpts = typeof o === 'string' ? { cls: o } : o;
    const el = document.createElement(tag);
    if (opts.text !== undefined) el.textContent = opts.text;
    if (opts.cls) el.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls;
    if (opts.type) el.setAttribute('type', opts.type);
    if (opts.placeholder) el.setAttribute('placeholder', opts.placeholder);
    for (const [k, v] of Object.entries(opts.attr ?? {})) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, o: ElOpts | string = {}) {
    return (this as unknown as { createEl: (t: string, o: unknown) => HTMLElement }).createEl('div', o);
  };
  proto.createSpan = function (this: HTMLElement, o: ElOpts | string = {}) {
    return (this as unknown as { createEl: (t: string, o: unknown) => HTMLElement }).createEl('span', o);
  };
  proto.empty = function (this: HTMLElement) { this.replaceChildren(); };
  proto.addClass = function (this: HTMLElement, ...c: string[]) { this.classList.add(...c); };
  proto.removeClass = function (this: HTMLElement, ...c: string[]) { this.classList.remove(...c); };
  proto.toggleClass = function (this: HTMLElement, c: string | string[], on: boolean) {
    for (const x of Array.isArray(c) ? c : [c]) this.classList.toggle(x, on);
  };
  proto.setText = function (this: HTMLElement, t: string) { this.textContent = t; };
  proto.setAttr = function (this: HTMLElement, k: string, v: string) { this.setAttribute(k, v); };
}
installDomHelpers();

export class Component {
  private events: Array<() => void> = [];
  registerEvent(_ref: unknown) {}
  registerInterval(id: number) { return id; }
  registerDomEvent(el: HTMLElement | Document | Window, type: string, cb: (e: never) => unknown) {
    el.addEventListener(type, cb as EventListener);
  }
}
export class ItemView extends Component {
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.containerEl = document.createElement('div');
    this.containerEl.appendChild(document.createElement('div')); // header
    this.contentEl = document.createElement('div');
    this.containerEl.appendChild(this.contentEl);
  }
  get app() { return (this.leaf as unknown as { app: unknown }).app as never; }
}
export class ToggleComponent {
  setValue() { return this; }
  setDisabled() { return this; }
  onChange() { return this; }
}
export const parseYaml = vi.fn(() => ({}));
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

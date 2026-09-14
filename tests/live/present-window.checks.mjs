import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentWindow } from './present-window.mjs';
test('presentation activates application and restores minimized QA window before readiness', async () => {
  let activated = false, dock = false, minimized = true, visible = false, focused = false, title;
  const app = { setActivationPolicy: value => { activated = value === 'regular'; }, dock: { show: async () => { dock = true; } }, focus() {} };
  const view = { isDestroyed: () => false, show: () => { visible = true; }, focus: () => { focused = activated && dock && !minimized; }, restore: () => { minimized = false; }, setTitle: value => { title = value; }, isVisible: () => visible, isFocused: () => focused, isMinimized: () => minimized };
  const result = await presentWindow({ evaluate: (fn, input) => fn({ app, BrowserWindow: { getAllWindows: () => [view] } }, input) }, 1);
  assert.deepEqual(result, { visible: true, focused: true, minimized: false }); assert.match(title, /QA Client 1/);
});
test('unpresentable window fails with actionable redacted message', async () => {
  const view = { isDestroyed: () => true };
  await assert.rejects(presentWindow({ evaluate: (fn, input) => fn({ app: {}, BrowserWindow: { getAllWindows: () => [view] } }, input) }, 1), /QA window unavailable/);
});

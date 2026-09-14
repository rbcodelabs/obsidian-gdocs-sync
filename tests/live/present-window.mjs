export async function presentWindow(electronApp, clientNumber) {
  return electronApp.evaluate(async ({ app, BrowserWindow }, number) => {
    const view = BrowserWindow.getAllWindows()[0];
    if (!view || view.isDestroyed()) throw new Error('QA window unavailable');
    if (app.setActivationPolicy) app.setActivationPolicy('regular');
    if (app.dock) await app.dock.show();
    view.setTitle(`Geode Disposable QA Client ${number} — TEST VAULT ONLY`);
    if (view.isMinimized()) view.restore();
    view.show(); app.focus({ steal: true }); view.focus();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = { visible: view.isVisible(), focused: view.isFocused(), minimized: view.isMinimized() };
      if (state.visible && state.focused && !state.minimized) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('QA window could not become visible and focused. Check macOS desktop/Spaces and retry; no sign-in started.');
  }, clientNumber);
}

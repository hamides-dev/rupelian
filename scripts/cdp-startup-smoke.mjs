import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { connectPlayer } from "./cdp-connection.mjs";

const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
assert.equal(config.app.windows.length, 1, "Startup must create only one WebView");
const main = config.app.windows[0];
assert.equal(main.label, "main");
assert.equal(main.visible, false, "The WebView player stays behind the native bootstrap until its shell paints");
assert.equal(main.transparent, false, "The native host stays opaque; only the WebView backing is released for mpv");
assert.deepEqual(main.backgroundColor, [11, 11, 12, 255], "Startup must have opaque backing until the shell paints");

const player = await connectPlayer();
try {
  const deadline = Date.now() + 10000;
  let snapshot;
  do {
    snapshot = await player.evaluate(`({
      ...window.__LINGO_STARTUP__,
      shellReady: document.body?.dataset.shellReady,
      nativeWindowShown: document.body?.dataset.nativeWindowShown,
      persistenceReady: document.body?.dataset.persistenceReady,
      libraryReady: document.body?.dataset.libraryReady,
      startupOverlayPresent: Boolean(document.querySelector('#startup-shell')),
      initializationError: document.body?.dataset.playerInitializationError,
      tauriRuntime: Boolean(window.__TAURI_INTERNALS__)
    })`);
    if (snapshot.persistenceReadyAt && snapshot.libraryReadyAt && !snapshot.startupOverlayPresent) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  const result = {
    ...snapshot,
    navigationToShellMs: Math.round(snapshot.shellReadyAt),
    scriptToShellMs: Math.round(snapshot.shellReadyAt - snapshot.scriptStartedAt)
  };
  console.log(JSON.stringify(result, null, 2));
  assert.equal(snapshot.initializationError, undefined);
  assert.equal(snapshot.shellReady, "true");
  assert.equal(snapshot.startupOverlayPresent, false);
  assert.ok(result.navigationToShellMs > 0 && result.navigationToShellMs < 2500, "Navigation-to-shell startup is too slow");
  assert.ok(snapshot.persistenceReadyAt >= snapshot.shellReadyAt, "Settings must hydrate after first shell paint");
  assert.ok(snapshot.libraryReadyAt >= snapshot.shellReadyAt, "Library must load after first shell paint");
  if (snapshot.tauriRuntime) {
    assert.equal(snapshot.nativeWindowShown, "true");
    assert.equal(await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', {label:'main'})`), true);
    assert.ok(snapshot.nativeStartup.windowCreatedMs > 0);
    assert.ok(snapshot.nativeStartup.shellReadyMs >= snapshot.nativeStartup.windowCreatedMs);
    // The loading UI must precede even loading the runtime DLL, not just its JS.
    assert.ok(snapshot.nativeStartup.firstVisibleAfterEntryMs < 500, "The native loading window did not paint promptly");
    assert.ok(snapshot.nativeStartup.firstVisibleUnixMs > 0);
    assert.ok(snapshot.nativeStartup.runtimeLoadStartedUnixMs >= snapshot.nativeStartup.firstVisibleUnixMs);
    assert.ok(snapshot.nativeStartup.runtimeStartedUnixMs >= snapshot.nativeStartup.runtimeLoadStartedUnixMs);
    assert.ok(snapshot.nativeStartup.shellReadyMs < 10000, "The player did not finish background initialization");
    assert.deepEqual(await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:webview|get_all_webviews').then(items => items.map(item => item.label))`), ['main']);
  }
} finally {
  player.close();
}

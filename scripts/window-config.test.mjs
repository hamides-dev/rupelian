import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const config = JSON.parse(await readFile(configUrl, "utf8"));
const mainWindow = config.app?.windows?.find((window) => window.label === "main");

test("the hidden Windows player keeps native file drop registration enabled", () => {
  assert.ok(mainWindow, "the main player window is missing");
  assert.equal(mainWindow.visible, false, "the native loading window requires the WebView to start hidden");
  assert.equal(
    mainWindow.focus,
    true,
    "a hidden, unfocused WebView2 window rejects native file drops in the current Wry runtime"
  );
  assert.equal(mainWindow.dragDropEnabled, true, "native Tauri drag/drop must stay enabled");
});

test("a missing native video surface cannot expose another desktop window", () => {
  assert.equal(mainWindow.transparent, false, "only the WebView may be transparent, not the desktop HWND");
  assert.equal(mainWindow.backgroundColor[3], 255, "startup must retain opaque backing");
});

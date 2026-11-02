import { writeFile } from "node:fs/promises";

const debugPort = process.env.LINGO_CDP_PORT || "9223";
const videoPath = process.argv[2];
if (!videoPath) throw new Error("Pass an absolute local video path.");

const pages = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
const page = pages.find((candidate) => candidate.url.includes("127.0.0.1:1420"));
if (!page) throw new Error("The Rupelian dev WebView was not found.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let id = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
const send = (method, params = {}) => new Promise((resolve) => {
  const commandId = ++id;
  pending.set(commandId, resolve);
  socket.send(JSON.stringify({ id: commandId, method, params }));
});
async function evaluate(expression) {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
  return response.result.result.value;
}
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const initial = await evaluate(`(async () => {
  const api = window.__LINGO_NATIVE_TEST__;
  await api.open(${JSON.stringify(videoPath)});
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline && (!api.snapshot().fileLoaded || api.snapshot().startupMs == null)) await new Promise((resolve) => setTimeout(resolve, 25));
  return { snapshot: api.snapshot(), settings: JSON.parse(localStorage.getItem("player-settings") || "{}"), progressStorage: localStorage.getItem("playback-progress-v1") };
})()`);

const localHeaderState = await evaluate(`(() => {
  const streamButton = [...document.querySelectorAll("button")].find((button) => button.title === "Open YouTube");
  const label = streamButton?.querySelector("span:last-child")?.textContent.trim() || "";
  streamButton?.click();
  const opensYoutubeModal = !document.querySelector("#youtube-modal").classList.contains("hidden");
  window.closeModal("youtube-modal");
  return { label, opensYoutubeModal, subtitleStudioRemoved: !document.querySelector("#subtitle-studio-header") };
})()`);

const iconClick = await evaluate(`(async () => {
  const api = window.__LINGO_NATIVE_TEST__;
  await api.play();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.title === "Play / Pause (Space)");
  const firstIcon = button.querySelector("path") || button.querySelector("svg");
  const iconPointerEvents = getComputedStyle(firstIcon).pointerEvents;
  const iconAppRegion = getComputedStyle(firstIcon).getPropertyValue("-webkit-app-region");
  firstIcon.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const pausedByIcon = api.snapshot().paused;
  const secondIcon = button.querySelector("path") || button.querySelector("svg");
  secondIcon.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  return { iconPointerEvents, iconAppRegion, pausedByIcon, resumedByIcon: !api.snapshot().paused };
})()`);

const shortcutUi = await evaluate(`(async () => {
  const api = window.__LINGO_NATIVE_TEST__;
  const original = api.shortcutSnapshot();
  api.replaceShortcuts(null);
  window.openSettingsTab("shortcuts");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const rows = document.querySelectorAll("#shortcut-settings-list .lp-shortcut-row").length;
  const youtubeBinding = document.querySelector('[data-shortcut-capture="openYoutube"]');
  const defaultYoutubeBinding = youtubeBinding?.textContent.trim();
  window.closeModal("settings-dialog");
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "y", code: "KeyY", ctrlKey: true }));
  const defaultBindingOpenedYoutube = !document.querySelector("#youtube-modal").classList.contains("hidden");
  window.closeModal("youtube-modal");
  window.openSettingsTab("shortcuts");
  document.querySelector('[data-shortcut-capture="openYoutube"]')?.click();
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "u", code: "KeyU", ctrlKey: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const changedBinding = document.querySelector('[data-shortcut-capture="openYoutube"]')?.textContent.trim();
  const storedBinding = JSON.parse(localStorage.getItem("player-settings") || "{}").shortcuts?.openYoutube;
  const documentsBinding = (await window.__TAURI_INTERNALS__.invoke("load_user_settings")).sections?.player?.shortcuts?.openYoutube;
  window.closeModal("settings-dialog");
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "y", code: "KeyY", ctrlKey: true }));
  const oldBindingDisabled = document.querySelector("#youtube-modal").classList.contains("hidden");
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "u", code: "KeyU", ctrlKey: true }));
  const changedBindingOpenedYoutube = !document.querySelector("#youtube-modal").classList.contains("hidden");
  window.closeModal("youtube-modal");
  api.replaceShortcuts(original);
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { rows, defaultYoutubeBinding, defaultBindingOpenedYoutube, changedBinding, storedBinding, documentsBinding, oldBindingDisabled, changedBindingOpenedYoutube };
})()`);

await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
await delay(100);
const keyboardVolume = await evaluate(`window.__LINGO_NATIVE_TEST__.snapshot()`);

await evaluate(`document.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }))`);
await delay(100);
const wheelVolume = await evaluate(`window.__LINGO_NATIVE_TEST__.snapshot()`);

const timeBeforeSeek = wheelVolume.currentTime;
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
await delay(450);
const seekOsd = await evaluate(`window.__LINGO_NATIVE_TEST__.snapshot()`);

const keyboardButtonFocus = await evaluate(`(() => {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.title === "Play / Pause (Space)");
  button.focus();
  const computed = getComputedStyle(button);
  const result = { focused: document.activeElement === button, outlineStyle: computed.outlineStyle, outlineWidth: computed.outlineWidth };
  button.blur();
  return result;
})()`);

const appearance = await evaluate(`(() => {
  const setValue = (selector, value, eventName = "change") => {
    const input = document.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new Event(eventName, { bubbles: true }));
  };
  document.querySelector('[data-subtitle-preset="gold"]').click();
  document.querySelector("#setting-subtitle-font").click();
  document.querySelector('[data-font-family="Tahoma"]')?.click();
  setValue("#setting-subtitle-bottom", "212", "input");
  const overlay = document.querySelector(".lp-caption-overlay");
  const computed = getComputedStyle(overlay);
  return {
    presetActive: document.querySelector('[data-subtitle-preset="gold"]').classList.contains("is-active"),
    overlayClass: overlay.className,
    font: computed.fontFamily,
    bottom: computed.bottom,
    background: computed.backgroundColor,
    color: computed.color,
    stored: JSON.parse(localStorage.getItem("player-settings") || "{}")
  };
})()`);

const resume = await evaluate(`(async () => {
  const api = window.__LINGO_NATIVE_TEST__;
  api.seek(123);
  let deadline = performance.now() + 4000;
  while (performance.now() < deadline && (api.snapshot().seeking || Math.abs(api.snapshot().currentTime - 123) > 1)) await new Promise((resolve) => setTimeout(resolve, 20));
  api.saveProgress();
  const saved = api.snapshot().savedProgress;
  const opening = api.openWithPrompt(${JSON.stringify(videoPath)});
  deadline = performance.now() + 2000;
  while (performance.now() < deadline && document.querySelector("#resume-dialog").classList.contains("hidden")) await new Promise((resolve) => setTimeout(resolve, 20));
  const promptVisible = !document.querySelector("#resume-dialog").classList.contains("hidden");
  const promptText = document.querySelector("#resume-dialog-time").textContent;
  document.querySelector("#resume-continue").click();
  await opening;
  deadline = performance.now() + 8000;
  while (performance.now() < deadline && (!api.snapshot().fileLoaded || Math.abs(api.snapshot().currentTime - saved.time) > 2)) await new Promise((resolve) => setTimeout(resolve, 25));
  const continued = api.snapshot();
  api.saveProgress();
  const restart = api.openWithPrompt(${JSON.stringify(videoPath)});
  deadline = performance.now() + 2000;
  while (performance.now() < deadline && document.querySelector("#resume-dialog").classList.contains("hidden")) await new Promise((resolve) => setTimeout(resolve, 20));
  document.querySelector("#resume-start-over").click();
  await restart;
  deadline = performance.now() + 8000;
  while (performance.now() < deadline && (!api.snapshot().fileLoaded || api.snapshot().currentTime > 3)) await new Promise((resolve) => setTimeout(resolve, 25));
  return { saved, promptVisible, promptText, continued, restarted: api.snapshot() };
})()`);

await evaluate(`(() => {
  const original = ${JSON.stringify(initial.settings)};
  const legacyFonts = { segoe: "Segoe UI", tahoma: "Tahoma", arial: "Arial", georgia: "Georgia", mono: "Consolas", system: "System default" };
  const restore = (selector, value, eventName = "change") => {
    const input = document.querySelector(selector);
    if (value == null) return;
    input.value = String(value);
    input.dispatchEvent(new Event(eventName, { bubbles: true }));
  };
  document.querySelector('[data-subtitle-preset="' + (original.subtitlePreset || "cinema") + '"]').click();
  document.querySelector("#setting-subtitle-font").click();
  document.querySelector("#subtitle-font-custom").value = legacyFonts[original.subtitleFont] || original.subtitleFont || "System default";
  document.querySelector("#apply-custom-subtitle-font").click();
  restore("#setting-subtitle-bottom", original.subtitleBottom || 132, "input");
  window.__LINGO_NATIVE_TEST__.setVolume(${initial.snapshot.volume}, { showOsd: false });
  const progressStorage = ${JSON.stringify(initial.progressStorage)};
  window.__LINGO_NATIVE_TEST__.restoreProgressStorage(progressStorage);
})()`);

const result = {
  initialVolume: initial.snapshot.volume,
  localHeaderState,
  iconClick,
  shortcutUi,
  keyboardVolume,
  wheelVolume,
  timeBeforeSeek,
  seekOsd,
  keyboardButtonFocus,
  appearance,
  resume
};
const passed = Math.abs(keyboardVolume.volume - Math.max(0, initial.snapshot.volume - .05)) < .011
  && localHeaderState.label === "YouTube Stream"
  && localHeaderState.opensYoutubeModal
  && localHeaderState.subtitleStudioRemoved
  && iconClick.iconPointerEvents === "none"
  && iconClick.pausedByIcon
  && iconClick.resumedByIcon
  && shortcutUi.rows >= 15
  && shortcutUi.defaultYoutubeBinding === "Ctrl + Y"
  && shortcutUi.defaultBindingOpenedYoutube
  && shortcutUi.changedBinding === "Ctrl + U"
  && shortcutUi.storedBinding === "Ctrl+KeyU"
  && shortcutUi.documentsBinding === "Ctrl+KeyU"
  && shortcutUi.oldBindingDisabled
  && shortcutUi.changedBindingOpenedYoutube
  && keyboardVolume.osdVisible
  && keyboardVolume.osdTitle.startsWith("Volume ")
  && Math.abs(wheelVolume.volume - initial.snapshot.volume) < .011
  && seekOsd.currentTime >= timeBeforeSeek + 4
  && seekOsd.osdTitle.startsWith("Forward ")
  && keyboardButtonFocus.focused
  && (keyboardButtonFocus.outlineStyle === "none" || keyboardButtonFocus.outlineWidth === "0px")
  && appearance.presetActive
  && appearance.overlayClass.includes("lp-subtitle-style-gold")
  && /Tahoma/i.test(appearance.font)
  && appearance.bottom === "212px"
  && appearance.background === "rgba(0, 0, 0, 0)"
  && appearance.color === "rgb(255, 228, 92)"
  && appearance.stored.subtitlePreset === "gold"
  && appearance.stored.subtitleFont === "Tahoma"
  && appearance.stored.subtitleBottom === 212
  && resume.saved?.time > 120
  && resume.promptVisible
  && resume.promptText.includes("02:03")
  && Math.abs(resume.continued.currentTime - resume.saved.time) < 2
  && resume.restarted.currentTime < 3
  && !resume.restarted.savedProgress;

console.log(JSON.stringify({ passed, ...result }, null, 2));
if (process.env.LINGO_SCREENSHOT) {
  await evaluate(`(async () => { window.openSettingsTab("subtitles"); await new Promise((resolve) => setTimeout(resolve, 300)); })()`);
  const screenshot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(process.env.LINGO_SCREENSHOT, Buffer.from(screenshot.result.data, "base64"));
}
socket.close();
if (!passed) process.exitCode = 1;

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const port = process.env.LINGO_CDP_PORT || "9223";
const expectedRoot = process.env.LINGO_EXPECTED_DATA_DIR;
if (!expectedRoot) throw new Error("LINGO_EXPECTED_DATA_DIR is required for the persistence smoke test");

const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = pages.find((candidate) => candidate.url.includes("127.0.0.1:1420") || candidate.url.startsWith("http://tauri.localhost"));
if (!page) throw new Error("Rupelian WebView was not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveSocket, reject) => {
  socket.addEventListener("open", resolveSocket, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
const send = (method, params = {}) => new Promise((resolveCommand) => {
  const commandId = ++id;
  pending.set(commandId, resolveCommand);
  socket.send(JSON.stringify({ id: commandId, method, params }));
});
const evaluate = async (expression) => {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
  return response.result.result.value;
};
const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

await send("Page.reload", { ignoreCache: true });
await delay(1400);
const fixturePath = resolve("tests/fixtures/subtitle-primary.srt");
const mediaIdentity = "persistence-smoke:media-2026-10-13";
const persistedApiKey = "sk-persistence-smoke-secret";
const result = await evaluate(`(async () => {
  for (let attempt = 0; attempt < 100 && !window.__LINGO_SUBTITLE_TEST__; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  for (let attempt = 0; attempt < 200 && document.body.dataset.persistenceReady !== "true"; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const api = window.__LINGO_SUBTITLE_TEST__;
  if (!api) throw new Error("Subtitle test API did not initialize");
  if (document.body.dataset.persistenceReady !== "true") throw new Error("Persistent settings did not hydrate");
  const invoke = window.__TAURI_INTERNALS__.invoke;
  await invoke("save_user_setting", { section: "player", value: { chromeDelay: 3000, seekSeconds: 10, shortcuts: { openYoutube: "Ctrl+KeyU" } } });
  await invoke("save_user_setting", { section: "translation", value: { provider: "openai", model: "test-model", apiKey: "must-not-be-persisted" } });
  await invoke("save_ai_credential", { provider: "openai", apiKey: ${JSON.stringify(persistedApiKey)} });
  const settings = await invoke("load_user_settings");
  const credentials = await invoke("load_ai_credentials");
  api.setMediaContext("local", ${JSON.stringify(mediaIdentity)});
  await api.loadLocalSubtitlePath(${JSON.stringify(fixturePath)}, true);
  const sourceSnapshot = api.snapshot();
  const source = sourceSnapshot.trackDetails.find((track) => track.source === "local");
  const fingerprint = api.sourceFingerprint(source.id);
  const saved = await invoke("save_subtitle_translation", { input: {
    mediaIdentity: ${JSON.stringify(mediaIdentity)},
    mediaLabel: "Persistence Smoke Video.mkv",
    sourceFingerprint: fingerprint,
    sourceLabel: source.label,
    sourceLanguage: source.language,
    targetLanguage: "Persian (Farsi)",
    targetLanguageCode: "fa",
    provider: "openai",
    model: "test-model",
    mode: "batch",
    totalCues: source.cues,
    requestCount: 2,
    tokenCount: 123,
    includeSourceFallbacks: true,
    translatedCues: [{ sourceIndex: 0, start: 0, end: 4, text: "ترجمه ماندگار آزمایشی" }]
  } });
  const loaded = await invoke("load_subtitle_translations", { mediaIdentity: ${JSON.stringify(mediaIdentity)} });
  await api.loadPersistedTranslations();
  const restored = api.snapshot();
  return { paths: api.persistentDataPaths(), settings, credentials, saved, loaded, restored };
})()`);
await evaluate(`localStorage.setItem("player-settings", JSON.stringify({ chromeDelay: 5000, seekSeconds: 30 }))`);
await send("Page.reload", { ignoreCache: true });
await delay(1400);
const authorityResult = await evaluate(`(async () => {
  for (let attempt = 0; attempt < 100 && !window.__LINGO_SUBTITLE_TEST__; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  for (let attempt = 0; attempt < 200 && document.body.dataset.persistenceReady !== "true"; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  if (document.body.dataset.persistenceReady !== "true") throw new Error("Persistent settings did not hydrate after reload");
  const settings = await window.__TAURI_INTERNALS__.invoke("load_user_settings");
  window.openSettingsTab("shortcuts");
  const shortcutControlValue = document.querySelector('[data-shortcut-capture="openYoutube"]')?.textContent.trim();
  window.closeModal("settings-dialog");
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "u", code: "KeyU", ctrlKey: true }));
  const shortcutOpenedYoutube = !document.querySelector("#youtube-modal").classList.contains("hidden");
  window.closeModal("youtube-modal");
  return {
    controlValue: document.querySelector("#setting-chrome-delay")?.value,
    cachedValue: JSON.parse(localStorage.getItem("player-settings") || "{}").chromeDelay,
    documentValue: settings.sections.player?.chromeDelay,
    documentShortcut: settings.sections.player?.shortcuts?.openYoutube,
    shortcutControlValue,
    shortcutOpenedYoutube,
    apiKeyValue: document.querySelector("#translation-api-key")?.value,
    credentials: await window.__TAURI_INTERNALS__.invoke("load_ai_credentials"),
    startup: window.__LINGO_STARTUP__
  };
})()`);
socket.close();

const settingsContents = await readFile(result.paths.settingsPath, "utf8");
const credentialsContents = await readFile(resolve(result.paths.rootPath, "credentials.json"), "utf8");
await stat(result.saved.jsonPath);
await stat(result.saved.srtPath);
const srtContents = await readFile(result.saved.srtPath, "utf8");
const normalizedExpectedRoot = resolve(expectedRoot).toLowerCase();
const normalizedActualRoot = resolve(result.paths.rootPath).toLowerCase();
const restoredTranslation = result.restored.trackDetails.find((track) => track.source === "translation");
const checks = {
  documentsRootUsed: normalizedActualRoot === normalizedExpectedRoot,
  settingsStored: result.settings.sections.player?.chromeDelay === 3000,
  shortcutsPersisted: result.settings.sections.player?.shortcuts?.openYoutube === "Ctrl+KeyU" && authorityResult.documentShortcut === "Ctrl+KeyU" && authorityResult.shortcutControlValue === "Ctrl + U" && authorityResult.shortcutOpenedYoutube,
  documentsSettingsWinOverCache: authorityResult.controlValue === "3000" && authorityResult.cachedValue === 3000 && authorityResult.documentValue === 3000,
  apiKeyExcluded: !settingsContents.includes("must-not-be-persisted") && !Object.hasOwn(result.settings.sections.translation || {}, "apiKey"),
  apiKeyRestoredAfterRestart: result.credentials.openai === persistedApiKey && authorityResult.credentials.openai === persistedApiKey && authorityResult.apiKeyValue === persistedApiKey,
  persistenceHydratedProgressively: authorityResult.startup?.shellReadyAt > 0 && authorityResult.startup?.persistenceReadyAt >= authorityResult.startup?.shellReadyAt,
  apiKeyEncryptedAtRest: !credentialsContents.includes(persistedApiKey) && !settingsContents.includes(persistedApiKey),
  projectReloaded: result.loaded.length === 1 && result.loaded[0].translatedCount === 1 && result.loaded[0].totalCues === 2 && !result.loaded[0].complete,
  srtWritten: srtContents.includes("00:00:00,000 --> 00:00:04,000") && srtContents.includes("ترجمه ماندگار آزمایشی"),
  frontendRestored: restoredTranslation?.persisted === true && restoredTranslation.translatedCount === 1 && restoredTranslation.totalCues === 2,
  restoredSelected: result.restored.primary === restoredTranslation?.id
};
console.log(JSON.stringify({ checks, rootPath: result.paths.rootPath, authorityResult, saved: result.saved, restoredTranslation }, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;

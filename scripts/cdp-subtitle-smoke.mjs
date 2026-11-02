import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const port = process.env.LINGO_CDP_PORT || "9223";
const primaryPath = resolve("tests/fixtures/subtitle-primary.srt");
const secondaryPath = resolve("tests/fixtures/subtitle-secondary.vtt");
const liveTranslationPath = resolve("tests/fixtures/subtitle-live-translation.srt");
const contextualMediaPath = String.raw`C:\Media\Context.Movie.2026.mkv`;
const translationTasks = [];
const mockServer = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt = payload.messages?.find((message) => message.role === "user")?.content || "";
      const marker = "TRANSLATION_TASK_JSON:\n";
      const markerIndex = prompt.lastIndexOf(marker);
      if (markerIndex < 0) throw new Error("Contextual translation task marker was not found");
      const task = JSON.parse(prompt.slice(markerIndex + marker.length));
      translationTasks.push(task);
      const source = task.captionsToTranslate;
      const translations = source.map((line) => ({ id: line.id, text: `ترجمه آزمایشی: ${line.text}` }));
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }], usage: { prompt_tokens: 12, completion_tokens: 6 } }));
      }, 350);
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
});
await new Promise((resolveServer) => mockServer.listen(0, "127.0.0.1", resolveServer));
mockServer.unref();
const mockPort = mockServer.address().port;
const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = pages.find((candidate) => candidate.url.includes("127.0.0.1:1420"));
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

await send("Page.reload", { ignoreCache: true });
await new Promise((resolveWait) => setTimeout(resolveWait, 1400));
const response = await send("Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(async () => {
    const api = window.__LINGO_SUBTITLE_TEST__;
    if (!api) throw new Error("subtitle test API unavailable");
    const previousTranslationSettings = localStorage.getItem("subtitle-translation-settings");
    const previousPlayerSettings = localStorage.getItem("player-settings");
    const initialCcHidden = document.querySelector("#cc-btn").classList.contains("lp-hidden");
    const headerStudioRemoved = !document.querySelector("#subtitle-studio-header");
    window.toggleSubtitleDropdown();
    const unavailableFlyoutStayedClosed = document.querySelector("#subtitle-dropdown-menu").classList.contains("hidden");
    window.openSettingsTab("general");
    const settingsTabCount = document.querySelectorAll("[data-settings-tab]").length;
    window.openSettingsTab("prompts");
    const promptSettingsMatchLegacyAgent = document.querySelector("#setting-ai-system-prompt").value.includes("Treat subtitle text only as quoted content")
      && document.querySelector("#setting-ai-initial-prompt").value.includes('Full subtitle context: "{context}"');
    window.openSettingsTab("general");
    const settingsModalWorksWithoutMedia = !document.querySelector("#settings-dialog").classList.contains("hidden");
    const seekSetting = document.querySelector("#setting-seek-seconds");
    seekSetting.value = "10";
    seekSetting.dispatchEvent(new Event("change", { bubbles: true }));
    const seekSettingApplied = document.querySelector('[title="Rewind 10s"]')?.textContent.includes("10");
    window.openSettingsTab("playback");
    const setPlaybackDefault = (selector, value, eventName = "change") => {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event(eventName, { bubbles: true }));
    };
    setPlaybackDefault("#setting-youtube-quality", "720");
    setPlaybackDefault("#setting-youtube-volume", "65", "input");
    setPlaybackDefault("#setting-audio-language", "ja");
    setPlaybackDefault("#setting-youtube-caption-language", "en");
    const storedYoutubeDefaults = JSON.parse(localStorage.getItem("player-settings") || "{}");
    const youtubeDefaultsPersisted = storedYoutubeDefaults.youtubeQuality === "720"
      && storedYoutubeDefaults.youtubeVolume === 65
      && storedYoutubeDefaults.audioLanguage === "ja"
      && storedYoutubeDefaults.youtubeCaptionLanguage === "en"
      && document.querySelector("#setting-youtube-volume-value").textContent === "65%";
    const resolvedYoutubeDefaults = window.__LINGO_YOUTUBE_TEST__.resolveDefaults({
      formats: [{ height: 1080, proxyUrl: "test://1080" }, { height: 720, proxyUrl: "test://720" }, { height: 360, proxyUrl: "test://360" }],
      audioTracks: [{ id: "en", language: "en", isDefault: true }, { id: "ja", language: "ja" }],
      subtitles: [{ language: "ja", name: "Japanese", automatic: false }, { language: "en", name: "English", automatic: false }]
    });
    const youtubeDefaultsResolveCorrectly = !resolvedYoutubeDefaults.autoQuality
      && resolvedYoutubeDefaults.formatHeight === 720
      && resolvedYoutubeDefaults.volume === 65
      && resolvedYoutubeDefaults.audioLanguage === "ja"
      && resolvedYoutubeDefaults.captionLanguage === "en";
    window.openSettingsTab("subtitles");
    const defaultMulti = document.querySelector("#setting-subtitle-multi");
    defaultMulti.checked = false;
    defaultMulti.dispatchEvent(new Event("change", { bubbles: true }));
    const defaultSize = document.querySelector("#setting-subtitle-size");
    defaultSize.value = "100";
    defaultSize.dispatchEvent(new Event("change", { bubbles: true }));
    const defaultSync = document.querySelector("#setting-subtitle-sync");
    defaultSync.value = "0";
    defaultSync.dispatchEvent(new Event("change", { bubbles: true }));
    const nativeQueryLocalFonts = window.queryLocalFonts;
    Object.defineProperty(window, "queryLocalFonts", { configurable: true, value: async () => [{ family: "Test Installed Font" }, { family: "Tahoma" }] });
    document.querySelector("#setting-subtitle-font").click();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    const discoveredFontOption = [...document.querySelectorAll("[data-font-family]")].find((option) => option.dataset.fontFamily === "Test Installed Font");
    [...document.querySelectorAll("[data-font-family]")].find((option) => option.dataset.fontFamily === "Tahoma")?.click();
    const systemFontPickerWorks = Boolean(discoveredFontOption)
      && document.querySelector("#setting-subtitle-font-label").textContent === "Tahoma"
      && getComputedStyle(document.querySelector(".lp-caption-overlay")).fontFamily.includes("Tahoma");
    if (nativeQueryLocalFonts) Object.defineProperty(window, "queryLocalFonts", { configurable: true, value: nativeQueryLocalFonts });
    else delete window.queryLocalFonts;
    const localFontAccessAvailable = typeof window.queryLocalFonts === "function";
    window.closeModal("settings-dialog");
    window.openModal("youtube-modal");
    const youtubeModalSimplified = !document.querySelector("#yt-browser-session")
      && !document.querySelector("#yt-stream-options")
      && !document.querySelector("#yt-format-select")
      && !document.querySelector("#yt-caption-select");
    window.closeModal("youtube-modal");
    api.setMediaContext("local", "", ${JSON.stringify(contextualMediaPath)});
    const mediaCcVisible = !document.querySelector("#cc-btn").classList.contains("lp-hidden");
    window.toggleSubtitleDropdown();
    const advancedHiddenWithoutTrack = ["#subtitle-master-controls", "#subtitle-multi-controls", "#open-translation-studio", "#subtitle-quick-controls"].every((selector) => document.querySelector(selector).classList.contains("hidden"));
    const localLoaderOnly = !document.querySelector("#load-local-subtitle").classList.contains("hidden") && document.querySelector("#fetch-youtube-cc").classList.contains("hidden");
    window.toggleSubtitleDropdown();
    await api.loadLocalSubtitlePath(${JSON.stringify(primaryPath)}, true);
    const advancedVisibleWithTrack = ["#subtitle-master-controls", "#subtitle-multi-controls", "#open-translation-studio", "#subtitle-quick-controls"].every((selector) => !document.querySelector(selector).classList.contains("hidden"));
    document.querySelector("#subtitle-multi-toggle").click();
    await api.loadLocalSubtitlePath(${JSON.stringify(secondaryPath)}, true);
    api.renderAt(1);
    const overlay = document.querySelector(".lp-caption-overlay");
    const overlayState = {
      visible: !overlay.classList.contains("lp-hidden"),
      primary: overlay.querySelector(".lp-caption-primary")?.textContent,
      secondary: overlay.querySelector(".lp-caption-secondary")?.textContent
    };
    const initialTrackCards = document.querySelectorAll(".lp-subtitle-track").length;
    const initialActiveCards = document.querySelectorAll(".lp-subtitle-track.is-active").length;
    const initialMultiLabel = document.querySelector("#subtitle-multi-label").textContent;
    document.querySelector("#subtitle-master-toggle").click();
    const hiddenWhenDisabled = overlay.classList.contains("lp-hidden");
    document.querySelector("#subtitle-master-toggle").click();
    api.renderAt(1);
    document.querySelector("#subtitle-sync-plus").click();
    document.querySelector("#subtitle-size-button").click();
    window.toggleSubtitleDropdown();
    document.querySelector(".lp-subtitle-track")?.click();
    const flyoutStayedOpenOnInsideClick = !document.querySelector("#subtitle-dropdown-menu").classList.contains("hidden");
    document.body.click();
    const flyoutClosedOnOutsideClick = document.querySelector("#subtitle-dropdown-menu").classList.contains("hidden");
    window.toggleSubtitleDropdown();
    document.querySelector("#open-translation-studio").click();
    const sourceSectionPresent = [...document.querySelectorAll("#subtitles-dialog *")].some((node) => node.textContent?.trim() === "SUBTITLE SOURCE");
    const initialAiDisabled = document.querySelector("#translate-entire-subtitle").disabled;
    document.querySelector("#ai-settings-toggle").click();
    const settingsVisible = !document.querySelector("#settings-dialog").classList.contains("hidden");
    const aiSettingsActive = document.querySelector('[data-settings-tab="ai"]').classList.contains("is-active") && !document.querySelector('[data-settings-panel="ai"]').classList.contains("hidden");
    const providerSettingsSeparated = !document.querySelector("#subtitles-dialog").contains(document.querySelector("#translation-provider")) && document.querySelector("#settings-dialog").contains(document.querySelector("#translation-provider"));
    const provider = document.querySelector("#translation-provider");
    const providerCount = provider.options.length;
    provider.value = "openrouter";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    const openRouterEndpointHidden = document.querySelector("#translation-endpoint-row").classList.contains("hidden");
    for (let attempt = 0; attempt < 200 && !api.modelSnapshot().length; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const onlineModels = api.modelSnapshot();
    const openRouterModelsLoaded = onlineModels.length > 0;
    const onlinePricingVisible = onlineModels.some((model) => model.promptPrice !== null && model.completionPrice !== null)
      && [...document.querySelectorAll(".lp-model-price")].some((node) => node.textContent.includes("In ") && node.textContent.includes("Out "));
    const modelSearch = document.querySelector("#translation-model-search");
    modelSearch.value = onlineModels[0]?.id?.split("/").pop().slice(0, 8) || "open";
    modelSearch.dispatchEvent(new Event("input", { bubbles: true }));
    const searchWorks = document.querySelectorAll("[data-ai-model]").length > 0;
    modelSearch.value = "";
    modelSearch.dispatchEvent(new Event("input", { bubbles: true }));
    provider.value = "custom";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    const endpoint = document.querySelector("#translation-endpoint");
    endpoint.value = ${JSON.stringify(`http://127.0.0.1:${mockPort}/v1`)};
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    const manualModel = document.querySelector("#translation-manual-model");
    manualModel.value = "test-model";
    manualModel.dispatchEvent(new Event("input", { bubbles: true }));
    const key = document.querySelector("#translation-api-key");
    key.value = "test-key";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#settings-dialog > div").click();
    const settingsStayedOpenOnInsideClick = !document.querySelector("#settings-dialog").classList.contains("hidden");
    document.querySelector("#settings-dialog").click();
    const settingsClosedOnOverlayClick = document.querySelector("#settings-dialog").classList.contains("hidden");
    const settingsClosed = document.querySelector("#settings-dialog").classList.contains("hidden");
    const aiReadyAfterKey = !document.querySelector("#translate-entire-subtitle").disabled;
    document.querySelector("#translate-entire-subtitle").click();
    const translationBusyNamesModel = document.querySelector("#translation-status").textContent === "Translating subtitles with test-model…";
    const translationActivatedDuringRun = document.querySelector('[data-subtitle-source="translation"]')?.classList.contains("is-active")
      && api.snapshot().trackDetails.find((track) => track.source === "translation")?.cues === 2;
    for (let attempt = 0; attempt < 100 && (document.querySelector("#translate-entire-subtitle").disabled || !document.querySelector("#translation-progress-label").textContent.includes("100%")); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    api.renderAt(1);
    const translationFinished = document.querySelector("#translation-progress-label").textContent.includes("2 of 2") && document.querySelector("#translation-usage").textContent.includes("18 tokens");
    const translationCardsAfterFull = [...document.querySelectorAll('[data-subtitle-source="translation"]')];
    const translationSelectedByDefault = translationCardsAfterFull[0]?.classList.contains("is-active")
      && document.querySelector("#translation-status").textContent === "Translated with test-model";
    const translationGroupFirst = document.querySelector("#subtitle-track-list .lp-subtitle-group > span")?.textContent === "AI translations";
    document.querySelector("#subtitle-multi-toggle").click();
    document.querySelector('[data-subtitle-source="translation"]')?.click();
    api.renderAt(1);
    const translationOnlyOverlay = document.querySelector(".lp-caption-primary")?.textContent;
    const translationOnlyHasNoSecondary = !document.querySelector(".lp-caption-secondary");
    const translationOnlyIsPrimary = document.querySelectorAll(".lp-subtitle-track.is-active").length === 1
      && document.querySelector('[data-subtitle-source="translation"]')?.classList.contains("is-active");
    const target = document.querySelector("#translation-target");
    target.value = "English";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await api.loadLocalSubtitlePath(${JSON.stringify(liveTranslationPath)}, true);
    document.querySelector("#translation-live-button").click();
    api.renderAt(.2);
    const liveTranslationCard = [...document.querySelectorAll('[data-subtitle-source="translation"]')].at(-1);
    liveTranslationCard?.click();
    api.renderAt(18.2, { seek: true });
    const livePendingPlaceholderVisible = document.querySelector(".lp-caption-primary")?.textContent === "Translating…"
      && document.querySelector(".lp-caption-primary")?.dataset.translationPending === "true";
    for (let attempt = 0; attempt < 160 && !document.querySelector(".lp-caption-primary")?.textContent.startsWith("ترجمه آزمایشی: Live cue 19"); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      api.renderAt(18.2);
    }
    const liveQueuedCueTranslated = document.querySelector(".lp-caption-primary")?.textContent.startsWith("ترجمه آزمایشی: Live cue 19")
      && document.querySelector(".lp-caption-primary")?.dataset.translationPending !== "true";
    const liveTranslationFinished = document.querySelector("#translation-live-button").textContent.includes("Cancel")
      && document.querySelector("#translation-live-button").dataset.liveState === "active"
      && document.querySelectorAll('[data-subtitle-source="translation"]').length === 2;
    document.querySelector("#translation-live-button").click();
    const liveCancelIndicated = document.querySelector("#translation-live-button").textContent.includes("Resume")
      && document.querySelector("#translation-live-button").dataset.liveState === "canceled"
      && document.querySelector("#translation-status").textContent === "Live translation canceled"
      && api.snapshot().translationLiveCanceled
      && !api.snapshot().primary.startsWith("translation:");
    if (previousTranslationSettings === null) localStorage.removeItem("subtitle-translation-settings");
    else localStorage.setItem("subtitle-translation-settings", previousTranslationSettings);
    if (previousPlayerSettings === null) localStorage.removeItem("player-settings");
    else localStorage.setItem("player-settings", previousPlayerSettings);
    return {
      snapshot: api.snapshot(),
      overlayState,
      hiddenWhenDisabled,
      romajiControlPresent: Boolean(document.querySelector("#romaji-toggle")),
      initialCcHidden,
      headerStudioRemoved,
      unavailableFlyoutStayedClosed,
      settingsTabCount,
      promptSettingsMatchLegacyAgent,
      settingsModalWorksWithoutMedia,
      seekSettingApplied,
      youtubeDefaultsPersisted,
      youtubeDefaultsResolveCorrectly,
      youtubeModalSimplified,
      systemFontPickerWorks,
      localFontAccessAvailable,
      mediaCcVisible,
      advancedHiddenWithoutTrack,
      localLoaderOnly,
      advancedVisibleWithTrack,
      initialTrackCards,
      initialActiveCards,
      initialMultiLabel,
      trackCards: document.querySelectorAll(".lp-subtitle-track").length,
      primaryCards: document.querySelectorAll(".lp-subtitle-track.is-active").length,
      multiLabel: document.querySelector("#subtitle-multi-label").textContent,
      sync: document.querySelector("#subtitle-sync-value").textContent,
      size: document.querySelector("#subtitle-size-value").textContent,
      studioVisible: !document.querySelector("#subtitles-dialog").classList.contains("hidden"),
      flyoutClosed: document.querySelector("#subtitle-dropdown-menu").classList.contains("hidden"),
      flyoutStayedOpenOnInsideClick,
      flyoutClosedOnOutsideClick,
      sourceSectionPresent,
      targetLanguagePresent: Boolean(document.querySelector("#translation-target")),
      settingsVisible,
      settingsStayedOpenOnInsideClick,
      settingsClosedOnOverlayClick,
      aiSettingsActive,
      providerSettingsSeparated,
      settingsClosed,
      providerCount,
      openRouterEndpointHidden,
      openRouterModelsLoaded,
      onlineModelCount: onlineModels.length,
      onlinePricingVisible,
      searchWorks,
      initialAiDisabled,
      aiReadyAfterKey,
      translationBusyNamesModel,
      translationActivatedDuringRun,
      translationFinished,
      translationSelectedByDefault,
      translationTrackCount: translationCardsAfterFull.length,
      translationGroupFirst,
      translationOnlyOverlay,
      translationOnlyHasNoSecondary,
      translationOnlyIsPrimary,
      liveTranslationFinished,
      livePendingPlaceholderVisible,
      liveQueuedCueTranslated,
      liveCancelIndicated,
      progress: document.querySelector("#translation-progress-label").textContent
    };
  })()`
});
if (response.result.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
const result = response.result.result.value;
const fullTask = translationTasks.find((task) => task.subtitle?.mode === "full");
const liveTasks = translationTasks.filter((task) => task.subtitle?.mode === "live");
const liveJumpTask = translationTasks.find((task) => task.subtitle?.mode === "live" && task.captionsToTranslate?.some((line) => line.id === 18));
result.agenticTranslationContext = {
  fullBatchCaptionCount: fullTask?.captionsToTranslate?.length || 0,
  mediaTitle: fullTask?.media?.titleOrFileName || "",
  subtitleTrackName: fullTask?.subtitle?.trackName || "",
  livePreviousContextIds: liveJumpTask?.previousContext?.map((line) => line.id) || [],
  liveTargetIds: liveJumpTask?.captionsToTranslate?.map((line) => line.id) || [],
  liveNextContextCount: liveJumpTask?.nextContext?.length || 0,
  seekDispatchedBeforeInitialResponse: liveTasks[0]?.captionsToTranslate?.[0]?.id === 0
    && liveTasks[1]?.captionsToTranslate?.[0]?.id === 18
};
console.log(JSON.stringify(result, null, 2));
if (result.initialTrackCards !== 2 || result.initialActiveCards !== 2 || result.initialMultiLabel !== "Simultaneous ON" || !result.snapshot.enabled) throw new Error("multi-track subtitle selection failed");
if (!result.overlayState.visible || !result.overlayState.primary?.includes("こんにちは") || !result.overlayState.secondary?.includes("سلام") || result.romajiControlPresent || !result.hiddenWhenDisabled) throw new Error("multi-line subtitle overlay failed");
if (result.sync !== "50ms" || result.size !== "110%") throw new Error("subtitle sync or sizing failed");
if (!result.initialCcHidden || !result.headerStudioRemoved || !result.unavailableFlyoutStayedClosed || result.settingsTabCount !== 7 || !result.promptSettingsMatchLegacyAgent || !result.settingsModalWorksWithoutMedia || !result.seekSettingApplied || !result.youtubeDefaultsPersisted || !result.youtubeDefaultsResolveCorrectly || !result.youtubeModalSimplified || !result.systemFontPickerWorks || !result.mediaCcVisible || !result.advancedHiddenWithoutTrack || !result.advancedVisibleWithTrack || !result.localLoaderOnly) throw new Error("context-aware subtitle controls, YouTube defaults, simplified YouTube modal, system-font picker, or settings tabs failed");
if (!result.studioVisible || !result.flyoutClosed || !result.flyoutStayedOpenOnInsideClick || !result.flyoutClosedOnOutsideClick || result.sourceSectionPresent || !result.targetLanguagePresent) throw new Error("translation studio layout or flyout dismissal failed");
if (result.providerCount < 14 || !result.openRouterEndpointHidden || !result.openRouterModelsLoaded || result.onlineModelCount < 10 || !result.onlinePricingVisible || !result.searchWorks) throw new Error("online multi-provider model catalog failed");
if (!result.settingsVisible || !result.settingsStayedOpenOnInsideClick || !result.settingsClosedOnOverlayClick || !result.aiSettingsActive || !result.providerSettingsSeparated || !result.settingsClosed || !result.initialAiDisabled || !result.aiReadyAfterKey || !result.translationBusyNamesModel || !result.translationActivatedDuringRun || !result.translationFinished || !result.translationSelectedByDefault || result.translationTrackCount !== 1 || !result.translationGroupFirst || !result.translationOnlyOverlay?.startsWith("ترجمه آزمایشی:") || !result.translationOnlyHasNoSecondary || !result.translationOnlyIsPrimary || !result.liveTranslationFinished || !result.livePendingPlaceholderVisible || !result.liveQueuedCueTranslated || !result.liveCancelIndicated) throw new Error("end-to-end translation activation, model status, look-ahead queue, cancellation state, track flow, or modal dismissal failed");
if (result.agenticTranslationContext.fullBatchCaptionCount !== 2
  || result.agenticTranslationContext.mediaTitle !== "Context.Movie.2026.mkv"
  || !result.agenticTranslationContext.subtitleTrackName
  || result.agenticTranslationContext.livePreviousContextIds.join(",") !== "13,14,15,16,17"
  || result.agenticTranslationContext.liveTargetIds.join(",") !== "18,19"
  || result.agenticTranslationContext.liveNextContextCount !== 0
  || !result.agenticTranslationContext.seekDispatchedBeforeInitialResponse) {
  throw new Error("context-aware batch translation did not receive the media name or five neighboring captions");
}
if (process.env.LINGO_SCREENSHOT) {
  if (process.env.LINGO_SCREENSHOT_VIEW === "flyout") {
    await send("Runtime.evaluate", { awaitPromise: true, expression: `(async () => { window.closeModal("subtitles-dialog"); document.body.classList.remove("lp-chrome-hidden"); document.body.classList.add("lp-chrome-visible"); document.querySelector("#subtitle-dropdown-menu").classList.remove("hidden"); await new Promise((resolveWait) => setTimeout(resolveWait, 400)); })()` });
  } else if (process.env.LINGO_SCREENSHOT_VIEW === "overlay") {
    await send("Runtime.evaluate", { awaitPromise: true, expression: `(async () => { window.closeModal("subtitles-dialog"); document.querySelector("#settings-dialog")?.classList.add("hidden"); document.body.classList.add("lp-chrome-hidden"); window.__LINGO_SUBTITLE_TEST__.renderAt(18.2); await new Promise((resolveWait) => setTimeout(resolveWait, 400)); })()` });
  } else if (process.env.LINGO_SCREENSHOT_VIEW === "models") {
    await send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `(async () => {
        window.__LINGO_SCREENSHOT_PREVIOUS_SETTINGS__ = localStorage.getItem("subtitle-translation-settings");
        window.openSettingsTab("ai");
        const provider = document.querySelector("#translation-provider");
        provider.value = "openrouter";
        provider.dispatchEvent(new Event("change", { bubbles: true }));
        for (let attempt = 0; attempt < 200 && !document.querySelector("[data-ai-model]"); attempt += 1) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
        document.querySelector("#translation-model-list").scrollTop = 0;
      })()`
    });
  }
  const screenshot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(process.env.LINGO_SCREENSHOT, Buffer.from(screenshot.result.data, "base64"));
  if (process.env.LINGO_SCREENSHOT_VIEW === "models") {
    await send("Runtime.evaluate", { expression: `window.__LINGO_SCREENSHOT_PREVIOUS_SETTINGS__ === null ? localStorage.removeItem("subtitle-translation-settings") : localStorage.setItem("subtitle-translation-settings", window.__LINGO_SCREENSHOT_PREVIOUS_SETTINGS__); delete window.__LINGO_SCREENSHOT_PREVIOUS_SETTINGS__;` });
  }
}
socket.close();
mockServer.close();

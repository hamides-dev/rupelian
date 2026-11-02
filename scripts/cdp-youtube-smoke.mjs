const port = process.env.LINGO_CDP_PORT || "9223";
const testVideoUrl = process.argv[2] || "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = pages.find((candidate) => candidate.url.includes("127.0.0.1:1420"));
if (!page) throw new Error("Rupelian WebView was not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.consoleAPICalled") {
    const output = message.params.args?.map((argument) => argument.value).join(" ") || "";
    if (output.startsWith("[YT-SMOKE]")) console.error(output);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    console.error("[YT-SMOKE] page exception", message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || "unknown");
    return;
  }
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
const send = (method, params = {}) => new Promise((resolve) => {
  const commandId = ++id;
  pending.set(commandId, resolve);
  socket.send(JSON.stringify({ id: commandId, method, params }));
});

await send("Runtime.enable");

await send("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 500));
for (let attempt = 0; attempt < 100; attempt += 1) {
  const ready = await send("Runtime.evaluate", {
    expression: "Boolean(window.__LINGO_YOUTUBE_TEST__ && window.__LINGO_NATIVE_TEST__)",
    returnByValue: true
  });
  if (ready.result?.result?.value) break;
  if (attempt === 99) throw new Error("Player test API did not initialize after reload");
  await new Promise((resolve) => setTimeout(resolve, 150));
}

const response = await send("Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(async () => {
    const stage = (message) => console.log("[YT-SMOKE] " + message);
    for (let attempt = 0; attempt < 150 && document.body.dataset.persistenceReady !== "true"; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (document.body.dataset.persistenceReady !== "true") throw new Error("Persistence did not hydrate before setting test defaults");
    stage("configuring saved defaults");
    window.__LINGO_YOUTUBE_TEST__.useHtmlFallback(true);
    const previousPlayerSettings = localStorage.getItem("player-settings");
    const previousProgressStorage = localStorage.getItem("playback-progress-v1");
    window.__LINGO_NATIVE_TEST__.restoreProgressStorage(null);
    try {
    const setDefault = (selector, value, eventName = "change") => {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event(eventName, { bubbles: true }));
    };
    setDefault("#setting-youtube-quality", "360");
    setDefault("#setting-youtube-volume", "65", "input");
    setDefault("#setting-audio-language", "original");
    setDefault("#setting-youtube-caption-language", "auto");
    const savedDefaults = JSON.parse(localStorage.getItem("player-settings") || "{}");
    const quality = document.querySelector("#quality-control");
    const preview = document.querySelector("#yt-video-preview");
    const play = document.querySelector("#yt-play-button");
    const ccButton = document.querySelector("#cc-btn");
    const initial = {
      titleRemoved: !document.querySelector("#media-title-container"),
      qualityHidden: quality.classList.contains("lp-hidden"),
      previewHidden: preview.classList.contains("hidden"),
      playDisabled: play.disabled,
      ccHidden: ccButton.classList.contains("lp-hidden"),
      subtitleStudioRemoved: !document.querySelector("#subtitle-studio-header"),
      simplifiedModal: !document.querySelector("#yt-browser-session") && !document.querySelector("#yt-stream-options") && !document.querySelector("#yt-format-select") && !document.querySelector("#yt-caption-select"),
      youtubeDefaultsStored: savedDefaults.youtubeQuality === "360" && savedDefaults.youtubeVolume === 65 && savedDefaults.audioLanguage === "original" && savedDefaults.youtubeCaptionLanguage === "auto"
    };
    window.openModal("youtube-modal");
    const input = document.querySelector("#yt-url-field");
    input.value = ${JSON.stringify(testVideoUrl)};
    document.querySelector("#yt-find-button").click();
    stage("resolving video metadata");
    const started = document.querySelector("#yt-find-button").disabled;
    const lookupLoaderStarted = !document.querySelector("#yt-loading-state").classList.contains("hidden")
      && document.querySelector("#youtube-modal").getAttribute("aria-busy") === "true";
    const brandedLoadingUi = Boolean(document.querySelector(".lp-player-loader .lp-loading-mark")
      && document.querySelector(".lp-player-loader .lp-loading-progress span")
      && document.querySelector("#yt-loading-state .lp-loading-mark")
      && document.querySelector("#yt-loading-state .lp-loading-progress span"));
    for (let attempt = 0; attempt < 240 && document.querySelector("#yt-find-button").disabled; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (document.querySelector("#yt-find-button").disabled) throw new Error("YouTube metadata lookup did not finish within 60 seconds");
    const lookupSnapshot = window.__LINGO_YOUTUBE_TEST__.snapshot();
    stage("metadata resolved " + JSON.stringify({ status: document.querySelector("#yt-status").textContent, playEnabled: !play.disabled, snapshot: lookupSnapshot }));
    if (play.disabled) throw new Error("YouTube lookup failed: " + document.querySelector("#yt-status").textContent);
    const lookup = {
      initial,
      modalVisible: !document.querySelector("#youtube-modal").classList.contains("hidden"),
      started,
      lookupLoaderStarted,
      lookupLoaderFinished: document.querySelector("#yt-loading-state").classList.contains("hidden") && document.querySelector("#youtube-modal").getAttribute("aria-busy") === "false",
      brandedLoadingUi,
      finished: !document.querySelector("#yt-find-button").disabled,
      status: document.querySelector("#yt-status").textContent,
      statusVisible: !document.querySelector("#yt-status").classList.contains("hidden"),
      previewVisible: !preview.classList.contains("hidden"),
      playEnabled: !play.disabled,
      formatCount: lookupSnapshot.lookupFormatCount,
      captionCount: lookupSnapshot.lookupCaptionCount
    };
    play.click();
    stage("starting playback with saved defaults");
    const video = document.querySelector("#native-video");
    const audio = document.querySelector("#youtube-audio");
    const thumbnailVideo = document.querySelector("video.lp-preview-source");
    for (let attempt = 0; attempt < 120 && (!video.duration || video.readyState < 1); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    stage("primary media metadata ready " + JSON.stringify({ duration: video.duration, readyState: video.readyState, networkState: video.networkState, error: video.error?.code || null, snapshot: window.__LINGO_YOUTUBE_TEST__.snapshot() }));
    for (let attempt = 0; attempt < 300 && (video.paused || (audio.hasAttribute("src") && audio.paused)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (video.paused || (audio.hasAttribute("src") && audio.paused)) {
      throw new Error("YouTube did not leave the shared startup buffer within 30 seconds: " + JSON.stringify(window.__LINGO_YOUTUBE_TEST__.snapshot()));
    }
    stage("playback started");
    const steadyStartTime = video.currentTime;
    const steadyStartSyncs = window.__LINGO_YOUTUBE_TEST__.snapshot().companionHardSyncCount;
    let previousSteadyTime = video.currentTime;
    let steadyBackwardJumps = 0;
    let steadySilentSamples = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (video.currentTime < previousSteadyTime - 0.12) steadyBackwardJumps += 1;
      if (audio.hasAttribute("src") && !video.paused && audio.paused) steadySilentSamples += 1;
      previousSteadyTime = video.currentTime;
    }
    const steadySnapshot = window.__LINGO_YOUTUBE_TEST__.snapshot();
    const steadyProgress = video.currentTime - steadyStartTime;
    const steadyHardSyncs = steadySnapshot.companionHardSyncCount - steadyStartSyncs;
    const steadyPlaybackHealthy = steadyProgress > 6 && steadyBackwardJumps === 0 && steadySilentSamples === 0 && steadyHardSyncs === 0;
    const previewDormantDuringPlayback = !thumbnailVideo.hasAttribute("src");
    stage("steady playback check " + JSON.stringify({ steadyProgress, steadyBackwardJumps, steadySilentSamples, steadyHardSyncs, buffer: steadySnapshot.buffer }));
    const initialAudioSnapshot = window.__LINGO_YOUTUBE_TEST__.snapshot();
    const optimizedSingleStreamDelivery = !initialAudioSnapshot.lookupHasMuxedFormat
      || (initialAudioSnapshot.selectedFormatHasEmbeddedAudio && !audio.hasAttribute("src"));
    const youtubeDefaultsApplied = initialAudioSnapshot.settings.quality === "360"
      && initialAudioSnapshot.selectedFormatHeight > 0
      && initialAudioSnapshot.selectedFormatHeight <= 360
      && !initialAudioSnapshot.autoQuality
      && Math.abs(initialAudioSnapshot.volume - .65) < .011;
    if (!youtubeDefaultsApplied) stage("defaults check failed " + JSON.stringify({ settings: initialAudioSnapshot.settings, height: initialAudioSnapshot.selectedFormatHeight, auto: initialAudioSnapshot.autoQuality, volume: initialAudioSnapshot.volume }));
    const audioTrackCount = initialAudioSnapshot.audioTracks.length;
    const audioSelectorVisible = audioTrackCount < 2 || !document.querySelector("#audio-track-control").classList.contains("lp-hidden");
    let audioTrackSwitched = audioTrackCount < 2;
    if (audioTrackCount > 1) {
      const nextAudio = initialAudioSnapshot.audioTracks.find((track) => track.id !== initialAudioSnapshot.selectedAudioTrackId);
      document.querySelector('[data-audio-track="' + CSS.escape(nextAudio.id) + '"]')?.click();
      for (let attempt = 0; attempt < 100 && window.__LINGO_YOUTUBE_TEST__.snapshot().selectedAudioTrackId !== nextAudio.id; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (let attempt = 0; attempt < 100 && (audio.readyState < 2 || audio.paused); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      audioTrackSwitched = window.__LINGO_YOUTUBE_TEST__.snapshot().selectedAudioTrackId === nextAudio.id && audio.hasAttribute("src");
    }
    stage("audio track checks complete");
    const startedWithSeparateAudio = audio.hasAttribute("src");
    const seekTarget = video.duration * 0.62;
    video.currentTime = seekTarget;
    await new Promise((resolve) => setTimeout(resolve, 1800));
    let audioRecoveredAfterRepeatedSeeks = true;
    let maximumRepeatedSeekDrift = 0;
    const repeatedSeekStates = [];
    for (const ratio of [0.24, 0.76, 0.43]) {
      stage("testing seek " + ratio);
      video.currentTime = video.duration * ratio;
      for (let attempt = 0; attempt < 240 && (video.seeking || video.paused || (audio.hasAttribute("src") && (audio.paused || Math.abs(audio.currentTime - video.currentTime) > 0.6))); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const drift = audio.hasAttribute("src") ? Math.abs(audio.currentTime - video.currentTime) : 0;
      maximumRepeatedSeekDrift = Math.max(maximumRepeatedSeekDrift, drift);
      if (audio.hasAttribute("src") && (!video.seeking && (audio.paused || drift > 0.6))) audioRecoveredAfterRepeatedSeeks = false;
      repeatedSeekStates.push({
        ratio,
        videoTime: video.currentTime,
        videoPaused: video.paused,
        videoSeeking: video.seeking,
        videoReadyState: video.readyState,
        audioTime: audio.currentTime,
        audioPaused: audio.paused,
        audioSeeking: audio.seeking,
        audioReadyState: audio.readyState,
        audioNetworkState: audio.networkState,
        audioError: audio.error?.code || null,
        audioDuration: audio.duration,
        drift
      });
    }
    stage("repeated seek checks complete");
    const rangeResponse = await fetch(video.src, { headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(12000) });
    const audioRangeResponse = audio.hasAttribute("src") ? await fetch(audio.src, { headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(12000) }) : null;
    stage("range proxy checks complete");
    const ccLabel = [...document.querySelectorAll("button")].find((button) => button.title === "Subtitles & AI Studio")?.textContent.replace(/\s+/g, " ").trim();
    const sourceBeforeQualityChange = video.src;
    const timeBeforeQualityChange = video.currentTime;
    document.querySelector('.yt-quality-option[data-format-index="1"]')?.click();
    const qualitySwitchFrozeBoth = video.paused && (!audio.hasAttribute("src") || audio.paused);
    for (let attempt = 0; attempt < 60 && video.src === sourceBeforeQualityChange; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    for (let attempt = 0; attempt < 120 && video.readyState < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    for (let attempt = 0; attempt < 240 && (video.seeking || video.paused || (audio.hasAttribute("src") && (audio.paused || Math.abs(audio.currentTime - video.currentTime) > 0.6))); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 900));
    stage("manual quality switch complete");
    const recoveryTimeBefore = video.currentTime;
    const audioSelectionBeforeRecovery = window.__LINGO_YOUTUBE_TEST__.snapshot().selectedAudioTrackId;
    window.__LINGO_YOUTUBE_TEST__.simulateNetworkError();
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const recovery = window.__LINGO_YOUTUBE_TEST__.snapshot();
      if (!recovery.recoveryInFlight && !recovery.buffer.active && !video.paused && (!audio.hasAttribute("src") || !audio.paused) && video.readyState >= 2 && !video.error && Math.abs(video.currentTime - recoveryTimeBefore) < 2.5) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const youtubeRecovery = window.__LINGO_YOUTUBE_TEST__.snapshot();
    stage("network recovery complete");
    const audioTrackPreservedAfterRecovery = audioSelectionBeforeRecovery === youtubeRecovery.selectedAudioTrackId;
    video.pause();
    document.querySelector('[title="Play / Pause (Space)"]').click();
    for (let attempt = 0; attempt < 300 && (video.paused || (audio.hasAttribute("src") && audio.paused)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const playContinuedYoutube = document.querySelector("#youtube-modal").classList.contains("hidden") && !video.paused && (!audio.hasAttribute("src") || !audio.paused) && window.__LINGO_YOUTUBE_TEST__.snapshot().sourceType === "youtube";
    const result = {
      ...lookup,
      duration: video.duration,
      readyState: video.readyState,
      mediaError: video.error?.code || null,
      seekTarget,
      seekedTime: video.currentTime,
      usesSeparateAudio: startedWithSeparateAudio,
      audioTrackCount,
      youtubeDefaultsApplied,
      optimizedSingleStreamDelivery,
      steadyPlaybackHealthy,
      steadyProgress,
      steadyBackwardJumps,
      steadySilentSamples,
      steadyHardSyncs,
      previewDormantDuringPlayback,
      qualitySwitchFrozeBoth,
      audioSelectorVisible,
      audioTrackSwitched,
      previewUsesDedicatedLowStream: lookup.formatCount < 2 || thumbnailVideo.src !== video.src,
      previewStreamHeight: thumbnailVideo.videoHeight,
      audioPlaying: !audio.hasAttribute("src") || !audio.paused,
      audioDrift: audio.hasAttribute("src") ? Math.abs(audio.currentTime - video.currentTime) : 0,
      audioRecoveredAfterRepeatedSeeks,
      maximumRepeatedSeekDrift,
      repeatedSeekStates,
      rangeStatus: rangeResponse.status,
      contentRange: rangeResponse.headers.get("content-range"),
      audioRangeStatus: audioRangeResponse?.status || null,
      audioContentRange: audioRangeResponse?.headers.get("content-range") || null,
      captionsLoaded: lookup.captionCount === 0 || !ccLabel?.includes("OFF"),
      ccLabel,
      subtitlePanelTrackCount: document.querySelectorAll("#subtitle-track-list .lp-subtitle-track").length,
      subtitlePanelGroups: [...document.querySelectorAll(".lp-subtitle-group > span")].map((item) => item.textContent.trim()),
      youtubeCaptionFetchEnabled: !document.querySelector("#fetch-youtube-cc").disabled,
      youtubeCaptionFetchVisible: !document.querySelector("#fetch-youtube-cc").classList.contains("hidden"),
      ccVisibleAfterLoad: !ccButton.classList.contains("lp-hidden"),
      titleStillRemovedAfterLoad: !document.querySelector("#media-title-container"),
      qualityVisibleAfterLoad: !quality.classList.contains("lp-hidden"),
      qualityOptions: document.querySelectorAll(".yt-quality-option").length,
      autoQualityActive: Boolean(document.querySelector(".yt-quality-auto")),
      qualitySwitched: lookup.formatCount < 2 || video.src !== sourceBeforeQualityChange,
      qualitySwitchPreservedTime: lookup.formatCount < 2 || Math.abs(recoveryTimeBefore - timeBeforeQualityChange) < 2.5,
      youtubeRecoveredFromNetworkError: youtubeRecovery.sourceType === "youtube" && youtubeRecovery.hasMedia && youtubeRecovery.hasFormat && !youtubeRecovery.recoveryInFlight && !youtubeRecovery.errorCode,
      youtubeRecoveryPreservedTime: Math.abs(youtubeRecovery.currentTime - recoveryTimeBefore) < 2.5,
      audioTrackPreservedAfterRecovery,
      playContinuedYoutube
    };
    video.pause();
    stage("finished");
    return result;
    } finally {
      if (previousPlayerSettings == null) localStorage.removeItem("player-settings");
      else localStorage.setItem("player-settings", previousPlayerSettings);
      window.__LINGO_NATIVE_TEST__.restoreProgressStorage(previousProgressStorage);
    }
  })()`
});
socket.close();
if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
const result = response.result.result.value;
console.log(JSON.stringify(result, null, 2));
if (!result.initial.titleRemoved || !result.initial.qualityHidden || !result.initial.previewHidden || !result.initial.playDisabled || !result.initial.ccHidden || !result.initial.subtitleStudioRemoved || !result.initial.simplifiedModal || !result.initial.youtubeDefaultsStored || !result.modalVisible || !result.started || !result.lookupLoaderStarted || !result.lookupLoaderFinished || !result.brandedLoadingUi || !result.finished || !result.statusVisible || !result.previewVisible || !result.playEnabled || result.formatCount < 1 || !result.youtubeDefaultsApplied || !result.optimizedSingleStreamDelivery || !result.steadyPlaybackHealthy || !result.previewDormantDuringPlayback || !result.qualitySwitchFrozeBoth || result.duration <= 0 || result.readyState < 2 || result.mediaError || !result.previewUsesDedicatedLowStream || result.previewStreamHeight > 360 || !result.audioSelectorVisible || !result.audioTrackSwitched || !result.audioPlaying || result.audioDrift > 0.6 || !result.audioRecoveredAfterRepeatedSeeks || result.maximumRepeatedSeekDrift > 0.6 || result.rangeStatus !== 206 || !result.contentRange || (result.usesSeparateAudio && (result.audioRangeStatus !== 206 || !result.audioContentRange)) || !result.captionsLoaded || (result.captionCount > 0 && (result.subtitlePanelTrackCount !== result.captionCount || !result.youtubeCaptionFetchEnabled || !result.youtubeCaptionFetchVisible || !result.subtitlePanelGroups.includes("Creator captions") || !result.subtitlePanelGroups.includes("Auto-generated captions"))) || !result.ccVisibleAfterLoad || !result.titleStillRemovedAfterLoad || !result.qualityVisibleAfterLoad || result.qualityOptions !== result.formatCount || !result.autoQualityActive || !result.qualitySwitched || !result.qualitySwitchPreservedTime || !result.youtubeRecoveredFromNetworkError || !result.youtubeRecoveryPreservedTime || !result.audioTrackPreservedAfterRecovery || !result.playContinuedYoutube) process.exitCode = 1;

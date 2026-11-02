const debugPort = process.env.LINGO_CDP_PORT || "9223";
const videoPath = process.argv[2];
const preferredAudioLanguage = process.argv[3] || "";
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

const consoleMessages = [];
await send("Runtime.enable");
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.consoleAPICalled") {
    consoleMessages.push(message.params.args.map((argument) => argument.value || argument.description || "").join(" "));
  }
});

const response = await send("Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(async () => {
    const api = window.__LINGO_NATIVE_TEST__;
    if (!api) throw new Error("native playback test API unavailable");
    const audioLanguageSetting = document.querySelector("#setting-audio-language");
    const previousAudioLanguage = audioLanguageSetting?.value || "original";
    if (${JSON.stringify(preferredAudioLanguage)}) {
      audioLanguageSetting.value = ${JSON.stringify(preferredAudioLanguage)};
      audioLanguageSetting.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await api.open(${JSON.stringify(videoPath)});
    const loadDeadline = performance.now() + 10000;
    while (performance.now() < loadDeadline && (!api.snapshot().fileLoaded || api.snapshot().startupMs == null)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const audioDiscoveryDeadline = performance.now() + 1500;
    while (performance.now() < audioDiscoveryDeadline && api.snapshot().audioTracks.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const loaded = api.snapshot();
    const audioLanguageAliases = { eng: "en", jpn: "ja", fas: "fa", per: "fa", kor: "ko", zho: "zh", chi: "zh", spa: "es", fra: "fr", fre: "fr", deu: "de", ger: "de", por: "pt", ara: "ar", hin: "hi", tur: "tr", rus: "ru" };
    const preferredAudioApplied = !${JSON.stringify(preferredAudioLanguage)} || loaded.audioTracks.some((track) => (
      track.id === loaded.selectedAudioTrackId && (audioLanguageAliases[track.language.toLowerCase().split("-")[0]] || track.language.toLowerCase().split("-")[0]) === ${JSON.stringify(preferredAudioLanguage)}
    ));
    let audioSwitch = { required: false, switched: true };
    if (loaded.audioTracks.length > 1) {
      const alternate = loaded.audioTracks.find((track) => track.id !== loaded.selectedAudioTrackId);
      await api.selectAudioTrack(alternate.id);
      const audioDeadline = performance.now() + 2500;
      while (performance.now() < audioDeadline && api.snapshot().selectedAudioTrackId !== alternate.id) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      audioSwitch = {
        required: true,
        target: alternate.id,
        selected: api.snapshot().selectedAudioTrackId,
        switched: api.snapshot().selectedAudioTrackId === alternate.id,
        selectorVisible: !document.querySelector("#audio-track-control").classList.contains("lp-hidden")
      };
    }
    const targets = [0.62, 0.17, 0.81, 0.34, 0.73].map((ratio) => loaded.duration * ratio);
    const seeks = [];
    for (const target of targets) {
      const started = performance.now();
      api.seek(target);
      const deadline = started + 3000;
      let snapshot;
      do {
        await new Promise((resolve) => setTimeout(resolve, 16));
        snapshot = api.snapshot();
      } while (performance.now() < deadline && (snapshot.seeking || Math.abs(snapshot.currentTime - target) > 0.8));
      seeks.push({ target, elapsed: Math.round(performance.now() - started), position: snapshot.currentTime, internalMs: snapshot.lastSeekMs });
    }
    const burstStarted = performance.now();
    let burstTarget = api.snapshot().currentTime;
    for (let index = 0; index < 12; index += 1) {
      burstTarget += 5;
      api.seek(burstTarget);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const burstLastCommandAt = performance.now();
    const burstDeadline = burstLastCommandAt + 2500;
    let burstSnapshot;
    do {
      await new Promise((resolve) => setTimeout(resolve, 16));
      burstSnapshot = api.snapshot();
    } while (performance.now() < burstDeadline && (burstSnapshot.seeking || Math.abs(burstSnapshot.currentTime - burstTarget) > 0.8));
    const burst = {
      target: burstTarget,
      totalElapsed: Math.round(performance.now() - burstStarted),
      settleAfterLastCommand: Math.round(performance.now() - burstLastCommandAt),
      position: burstSnapshot.currentTime
    };
    api.preview(37);
    const previewDeadline = performance.now() + 4000;
    while (performance.now() < previewDeadline && api.snapshot().previewFrames < 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const preview = {
      count: api.snapshot().previewFrames,
      imageLoaded: Boolean(document.querySelector(".lp-timeline-preview img")?.src)
    };
    const timeline = document.querySelector(".yt-scrub-track");
    const previewCard = document.querySelector(".lp-timeline-preview");
    const timelineBounds = timeline.getBoundingClientRect();
    previewCard.classList.remove("hidden");
    const rapidStartX = timelineBounds.left + timelineBounds.width * .12;
    const rapidEndX = timelineBounds.left + timelineBounds.width * .88;
    timeline.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: rapidStartX, clientY: timelineBounds.top + timelineBounds.height / 2 }));
    const rapidStartRect = previewCard.getBoundingClientRect();
    const rapidStartCenter = rapidStartRect.left + rapidStartRect.width / 2;
    timeline.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: rapidEndX, clientY: timelineBounds.top + timelineBounds.height / 2 }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const rapidEndRect = previewCard.getBoundingClientRect();
    const rapidTravel = rapidEndRect.left + rapidEndRect.width / 2 - rapidStartCenter;
    const rapidLagPx = Math.abs(rapidTravel - (rapidEndX - rapidStartX));
    preview.pointerFollow = {
      passed: rapidLagPx < 2 && !getComputedStyle(previewCard).transitionProperty.split(",").some((property) => ["all", "left"].includes(property.trim())),
      lagPx: rapidLagPx,
      transitionProperty: getComputedStyle(previewCard).transitionProperty,
      inlineLeft: previewCard.style.left,
      timelineWidth: timelineBounds.width,
      timelineOffsetWidth: timeline.offsetWidth,
      timelineOffsetLeft: timeline.offsetLeft
    };
    previewCard.classList.add("hidden");

    const fullscreenButton = document.querySelector('[title="Fullscreen (F)"]');
    const fullscreenState = () => window.__TAURI_INTERNALS__.invoke("plugin:window|is_fullscreen", { label: "main" });
    if (await fullscreenState()) {
      fullscreenButton.click();
      const resetDeadline = performance.now() + 2500;
      while (performance.now() < resetDeadline && await fullscreenState()) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const fullscreenCycles = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      fullscreenButton.click();
      const enterFullscreenDeadline = performance.now() + 3000;
      while (performance.now() < enterFullscreenDeadline && (!(await fullscreenState()) || !api.snapshot().videoVisible)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const transition = {
        entered: await fullscreenState(),
        visibleAfterEnter: api.snapshot().videoVisible
      };
      fullscreenButton.click();
      const exitFullscreenDeadline = performance.now() + 3000;
      while (performance.now() < exitFullscreenDeadline && ((await fullscreenState()) || !api.snapshot().videoVisible)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      transition.exited = !(await fullscreenState());
      transition.visibleAfterExit = api.snapshot().videoVisible;
      fullscreenCycles.push(transition);
    }
    const fullscreenSurface = {
      cycles: fullscreenCycles,
      passed: fullscreenCycles.every((transition) => transition.entered && transition.visibleAfterEnter && transition.exited && transition.visibleAfterExit)
    };

    api.seek(Math.max(0, loaded.duration - .35));
    await api.play();
    const eofDeadline = performance.now() + 4000;
    while (performance.now() < eofDeadline && !api.snapshot().eof) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const endFrameDeadline = performance.now() + 2500;
    while (performance.now() < endFrameDeadline && (!api.snapshot().endFrameVisible || !api.snapshot().endFrameLoaded)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const eofSnapshot = api.snapshot();
    const eofSurface = {
      reached: eofSnapshot.eof,
      videoVisible: eofSnapshot.videoVisible,
      endFrameVisible: eofSnapshot.endFrameVisible,
      endFrameLoaded: eofSnapshot.endFrameLoaded,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      stageBackground: getComputedStyle(document.querySelector("#player-stage")).backgroundImage
    };
    await api.play();
    const replayDeadline = performance.now() + 3000;
    while (performance.now() < replayDeadline) {
      const replayState = api.snapshot();
      if (!replayState.eof && replayState.videoVisible && replayState.currentTime > .05) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const replay = api.snapshot();
    await api.play();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const final = api.snapshot();
    if (${JSON.stringify(preferredAudioLanguage)}) {
      audioLanguageSetting.value = previousAudioLanguage;
      audioLanguageSetting.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return {
      loaded,
      preferredAudioApplied,
      audioSwitch,
      seeks,
      burst,
      preview,
      fullscreenSurface,
      eofSurface,
      replay,
      final,
      bodyNative: document.body.classList.contains("lp-native-local-active"),
      nativeVideoVisible: document.body.classList.contains("lp-native-video-visible"),
      htmlVideoHasSource: document.querySelector("#native-video").hasAttribute("src"),
      ccVisible: !document.querySelector("#cc-btn").classList.contains("lp-hidden"),
      loaderHidden: document.querySelector(".lp-player-loader").classList.contains("lp-hidden")
    };
  })()`
});

if (response.result?.exceptionDetails) {
  throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
}
const result = response.result.result.value;
const passed = result.loaded.backend === "mpv"
  && result.loaded.available
  && result.loaded.fileLoaded
  && result.loaded.duration > 0
  && result.loaded.width > 0
  && result.loaded.height > 0
  && result.bodyNative
  && result.nativeVideoVisible
  && !result.htmlVideoHasSource
  && result.ccVisible
  && result.loaderHidden
  && result.preferredAudioApplied
  && result.audioSwitch.switched
  && (!result.audioSwitch.required || result.audioSwitch.selectorVisible)
  && result.seeks.every((seek) => seek.elapsed < 1500 && Math.abs(seek.position - seek.target) < 1.2)
  && result.burst.settleAfterLastCommand < 1000
  && Math.abs(result.burst.position - result.burst.target) < 1.2
  && result.preview.count > 0
  && result.preview.imageLoaded
  && result.preview.pointerFollow.passed
  && result.fullscreenSurface.passed
  && result.eofSurface.reached
  && !result.eofSurface.videoVisible
  && result.eofSurface.endFrameVisible
  && result.eofSurface.endFrameLoaded
  && result.eofSurface.bodyBackground !== "rgba(0, 0, 0, 0)"
  && !result.replay.eof
  && result.replay.videoVisible
  && !result.replay.endFrameVisible
  && result.replay.currentTime > .05;

console.log(JSON.stringify({ passed, ...result, consoleMessages }, null, 2));
socket.close();
if (!passed) process.exitCode = 1;

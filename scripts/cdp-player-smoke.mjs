const debugPort = process.env.LINGO_CDP_PORT || "9223";
const videoPath = process.argv[2];
const incompatibleVideoPath = process.argv[3] || null;

if (!videoPath) {
  throw new Error("Pass an absolute video path as the first argument.");
}

const pages = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
const page = pages.find((candidate) => candidate.url.includes("127.0.0.1:1420"));

if (!page) {
  throw new Error("The Rupelian dev WebView was not found.");
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let commandId = 0;
const pendingCommands = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const resolve = pendingCommands.get(message.id);
  if (resolve) {
    pendingCommands.delete(message.id);
    resolve(message);
  }
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++commandId;
    pendingCommands.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const expression = `
  (async () => {
    const video = document.querySelector("#native-video");
    const findButton = (title) => [...document.querySelectorAll("button")].find((button) => button.title === title);
    const source = window.__TAURI_INTERNALS__.convertFileSrc(${JSON.stringify(videoPath)});
    const mediaResponse = await fetch(source);
    const droppedFile = new File([await mediaResponse.blob()], "lingo-player-smoke.mp4", { type: "video/mp4" });
    const transfer = new DataTransfer();
    transfer.items.add(droppedFile);
    const staleCaption = document.querySelector(".lp-caption-overlay");
    const staleDictionary = document.querySelector(".yt-cc-box")?.previousElementSibling;
    const staleMarker = document.querySelector('[title="Current Subtitle Mark"]');
    const initialLoadStartedAt = performance.now();
    let firstPlayingAt = null;
    video.addEventListener("playing", () => { firstPlayingAt ??= performance.now(); });
    staleCaption.textContent = "subtitle from the previous video";
    staleCaption.classList.remove("lp-hidden");
    staleDictionary?.classList.remove("lp-hidden");
    staleMarker?.classList.remove("lp-hidden");
    document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("metadata timeout")), 8000);
      video.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
      video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("media error " + video.error?.code)); }, { once: true });
    });
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const playButton = findButton("Play / Pause (Space)");
    const playingRect = playButton.getBoundingClientRect();
    playButton.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const pausedByControl = video.paused;
    const pausedRect = playButton.getBoundingClientRect();
    playButton.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const resumedByControl = !video.paused;

    findButton("Playback Speed").click();
    const scrubTrack = document.querySelector(".yt-scrub-track");
    const bounds = scrubTrack.getBoundingClientRect();
    const hiddenPreviewVideo = document.querySelector("video.lp-preview-source:not(#youtube-audio)");
    const preSeekPreviewState = {
      hasSource: hiddenPreviewVideo.hasAttribute("src"),
      readyState: hiddenPreviewVideo.readyState,
      hasDisplayedFrame: document.querySelector(".lp-timeline-preview img")?.src.startsWith("data:image/jpeg") || false
    };
    let seekEventCount = 0;
    video.addEventListener("seeking", () => { seekEventCount += 1; });
    scrubTrack.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 90,
      pointerType: "mouse",
      button: 0,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2
    }));
    const seekStartedAt = performance.now();
    const seekCompleted = new Promise((resolve) => video.addEventListener("seeked", () => resolve(performance.now()), { once: true }));
    scrubTrack.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 90,
      pointerType: "mouse",
      button: 0,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const immediateSeekFrameShown = !document.querySelector(".lp-seek-preview").classList.contains("lp-hidden");
    const seekCompletedAt = await Promise.race([
      seekCompleted,
      new Promise((resolve) => setTimeout(() => resolve(performance.now()), 3000))
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const timelineClickSoughtOnce = seekEventCount === 1;
    const localSeekStayedPlaying = !video.paused;
    const localSeekAvoidedLoader = document.querySelector(".lp-player-loader").classList.contains("lp-hidden");

    const timeRow = scrubTrack.nextElementSibling;
    const timeLabels = [...timeRow.querySelectorAll("span")];
    const playedFill = scrubTrack.firstElementChild.children[1];
    const preview = document.querySelector(".lp-timeline-preview");
    const previewPrewarmed = !preview.classList.contains("lp-preview-unavailable");
    scrubTrack.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      clientX: bounds.left + bounds.width * 0.75,
      clientY: bounds.top + bounds.height / 2
    }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const previewCaptured = !preview.classList.contains("lp-preview-unavailable") && preview.querySelector("img")?.src.startsWith("data:image/jpeg");
    const previewHasNoCaptionRow = preview.children.length === 1;
    const previewStayedReadyDuringPrewarm = !preview.classList.contains("lp-preview-loading");
    preview.classList.remove("hidden");
    const rapidPreviewStartX = bounds.left + bounds.width * .12;
    const rapidPreviewEndX = bounds.left + bounds.width * .88;
    scrubTrack.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      clientX: rapidPreviewStartX,
      clientY: bounds.top + bounds.height / 2
    }));
    const rapidPreviewStartRect = preview.getBoundingClientRect();
    const rapidPreviewStartCenter = rapidPreviewStartRect.left + rapidPreviewStartRect.width / 2;
    scrubTrack.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      clientX: rapidPreviewEndX,
      clientY: bounds.top + bounds.height / 2
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const rapidPreviewRect = preview.getBoundingClientRect();
    const rapidPreviewTravel = rapidPreviewRect.left + rapidPreviewRect.width / 2 - rapidPreviewStartCenter;
    const rapidPreviewLagPx = Math.abs(rapidPreviewTravel - (rapidPreviewEndX - rapidPreviewStartX));
    const rapidPreviewFollowsPointer = rapidPreviewLagPx < 2 && !getComputedStyle(preview).transitionProperty.split(",").some((property) => ["all", "left"].includes(property.trim()));
    const previewRect = preview.getBoundingClientRect();
    const previewAboveTimeline = previewRect.bottom <= scrubTrack.getBoundingClientRect().top + 2;
    preview.classList.add("hidden");

    video.pause();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const thumb = document.querySelector(".yt-thumb");
    const thumbRect = thumb.getBoundingClientRect();
    const dragStartX = thumbRect.right - 1;
    const timeBeforeThumbPress = video.currentTime;
    thumb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 91, pointerType: "mouse", button: 0, clientX: dragStartX, clientY: thumbRect.top + thumbRect.height / 2 }));
    const thumbPressDidNotJump = Math.abs(video.currentTime - timeBeforeThumbPress) < 0.03;
    const dragDistance = Math.min(80, bounds.width / 5);
    scrubTrack.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 91, pointerType: "mouse", button: 0, clientX: dragStartX + dragDistance, clientY: bounds.top + bounds.height / 2 }));
    const expectedTimeAfterDrag = timeBeforeThumbPress + dragDistance / bounds.width * video.duration;
    const thumbDragDeferredUntilRelease = Math.abs(video.currentTime - timeBeforeThumbPress) < 0.03;
    scrubTrack.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 91, pointerType: "mouse", button: 0, clientX: dragStartX + dragDistance, clientY: bounds.top + bounds.height / 2 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const thumbDragPreservedGrabOffset = Math.abs(video.currentTime - expectedTimeAfterDrag) < 0.08;

    const volumeTrack = findButton("Mute/Unmute").nextElementSibling;
    const volumeBounds = volumeTrack.getBoundingClientRect();
    const originalVolume = video.volume;
    volumeTrack.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 92, pointerType: "mouse", button: 0, clientX: volumeBounds.left + volumeBounds.width * 0.2, clientY: volumeBounds.top + volumeBounds.height / 2 }));
    volumeTrack.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 92, pointerType: "mouse", button: 0, clientX: volumeBounds.left + volumeBounds.width * 0.75, clientY: volumeBounds.top + volumeBounds.height / 2 }));
    volumeTrack.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 92, pointerType: "mouse", button: 0, clientX: volumeBounds.left + volumeBounds.width * 0.75, clientY: volumeBounds.top + volumeBounds.height / 2 }));
    const volumeDragged = Math.abs(video.volume - 0.75) < 0.02 && volumeTrack.firstElementChild.style.width.startsWith("75");
    video.volume = originalVolume;
    volumeTrack.firstElementChild.style.width = (originalVolume * 100) + "%";
    await video.play();

    window.openModal("youtube-modal");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const modalPausedPlayback = video.paused;
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "Space", key: " " }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const modalBlockedSpaceResume = video.paused;
    window.closeModal("youtube-modal");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const modalStayedPausedAfterClose = video.paused;
    await video.play();

    const ccButton = findButton("Subtitles & AI Studio");
    const speedButton = findButton("Playback Speed");
    const ccStyle = getComputedStyle(ccButton);
    const speedStyle = getComputedStyle(speedButton);
    const loader = document.querySelector(".lp-player-loader");
    const brandedLoadingUi = Boolean(loader.querySelector(".lp-loading-mark") && loader.querySelector(".lp-loading-progress span") && document.querySelector("#yt-loading-state .lp-loading-mark") && document.querySelector("#yt-loading-state .lp-loading-progress span"));
    video.dispatchEvent(new Event("waiting"));
    const localWaitingAvoidedLoader = loader.classList.contains("lp-hidden");
    video.dispatchEvent(new Event("canplay"));
    await new Promise((resolve) => setTimeout(resolve, 160));
    const loaderHiddenAfterCanPlay = loader.classList.contains("lp-hidden");
    let compatibilityFallbackPlayable = true;
    if (${JSON.stringify(incompatibleVideoPath)}) {
      const compatiblePath = await window.__TAURI_INTERNALS__.invoke("prepare_compatible_video", { path: ${JSON.stringify(incompatibleVideoPath)} });
      const compatibilityProbe = document.createElement("video");
      compatibilityProbe.preload = "metadata";
      compatibilityProbe.src = window.__TAURI_INTERNALS__.convertFileSrc(compatiblePath);
      compatibilityProbe.load();
      compatibilityFallbackPlayable = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 15000);
        compatibilityProbe.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(compatibilityProbe.videoWidth > 0 && compatibilityProbe.duration > 0); }, { once: true });
        compatibilityProbe.addEventListener("error", () => { clearTimeout(timer); resolve(false); }, { once: true });
      });
    }
    const result = {
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      pausedByControl,
      resumedByControl,
      playbackRate: video.playbackRate,
      width: video.videoWidth,
      height: video.videoHeight,
      readyState: video.readyState,
      error: video.error?.code || null,
      currentTimeLabel: timeLabels[0]?.textContent,
      durationLabel: timeLabels[2]?.textContent,
      playedWidth: playedFill.style.width,
      playSizeWhilePlaying: [playingRect.width, playingRect.height],
      playSizeWhilePaused: [pausedRect.width, pausedRect.height],
      ccOffHasShadow: ccStyle.boxShadow !== "none",
      ccOffBackgroundMatchesSpeed: ccStyle.backgroundColor === speedStyle.backgroundColor,
      previewPrewarmed,
      previewCaptured,
      previewHasNoCaptionRow,
      previewStayedReadyDuringPrewarm,
      rapidPreviewFollowsPointer,
      rapidPreviewLagPx,
      previewAboveTimeline,
      previewBottom: previewRect.bottom,
      timelineTop: scrubTrack.getBoundingClientRect().top,
      thumbPressDidNotJump,
      thumbDragDeferredUntilRelease,
      thumbDragPreservedGrabOffset,
      timelineClickSoughtOnce,
      fastSeekAvailable: typeof video.fastSeek === "function",
      preSeekPreviewState,
      initialPlaybackLatencyMs: firstPlayingAt == null ? null : firstPlayingAt - initialLoadStartedAt,
      localSeekLatencyMs: seekCompletedAt - seekStartedAt,
      immediateSeekFrameShown,
      localSeekStayedPlaying,
      localSeekAvoidedLoader,
      volumeDragged,
      modalPausedPlayback,
      modalBlockedSpaceResume,
      modalStayedPausedAfterClose,
      brandedLoadingUi,
      localWaitingAvoidedLoader,
      loaderHiddenAfterCanPlay,
      compatibilityFallbackPlayable,
      previousSubtitleCleared: staleCaption.classList.contains("lp-hidden") && !staleCaption.textContent && staleDictionary?.classList.contains("lp-hidden") && (!staleMarker || staleMarker.classList.contains("lp-hidden")) && !document.querySelector("#subtitle-master-toggle").checked && !ccButton.classList.contains("bg-[#FF0000]"),
      staticSubtitleCardHidden: document.querySelector(".yt-cc-box")?.classList.contains("lp-hidden"),
      dictionaryCardHidden: document.querySelector(".yt-cc-box")?.previousElementSibling?.classList.contains("lp-hidden")
    };

    video.pause();
    video.playbackRate = 1;
    findButton("Playback Speed").textContent = "1.0x";
    return result;
  })()
`;

const response = await send("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true
});

if (response.result?.exceptionDetails) {
  throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
}

const result = response.result?.result?.value;
const readThumbRect = async () => {
  const rectResponse = await send("Runtime.evaluate", {
    expression: `(() => { const rect = document.querySelector(".yt-thumb").getBoundingClientRect(); return { left: rect.left, width: rect.width, center: rect.left + rect.width / 2, top: rect.top, height: rect.height }; })()`,
    returnByValue: true
  });
  return rectResponse.result.result.value;
};
const thumbBeforeHover = await readThumbRect();
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: thumbBeforeHover.center, y: thumbBeforeHover.top + thumbBeforeHover.height / 2 });
await new Promise((resolve) => setTimeout(resolve, 180));
const thumbAfterHover = await readThumbRect();
result.thumbHoverCenterStable = Math.abs(thumbBeforeHover.center - thumbAfterHover.center) < 0.1 && thumbAfterHover.width > thumbBeforeHover.width;
result.thumbBeforeHover = thumbBeforeHover;
result.thumbAfterHover = thumbAfterHover;
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
await send("Runtime.evaluate", { expression: `(() => { const video = document.querySelector("#native-video"); video.pause(); video.removeAttribute("src"); video.classList.remove("has-source"); video.load(); })()` });
socket.close();

console.log(JSON.stringify(result, null, 2));

if (
  !result || result.error || !result.pausedByControl || !result.resumedByControl ||
  result.currentTime < 1.5 || result.duration <= 0 || result.playbackRate !== 1.25 ||
  result.playedWidth === "0%" || result.playSizeWhilePlaying.join("x") !== result.playSizeWhilePaused.join("x") ||
  result.ccOffHasShadow || !result.ccOffBackgroundMatchesSpeed ||
  !result.previewCaptured || !result.previewHasNoCaptionRow || !result.previewStayedReadyDuringPrewarm || !result.rapidPreviewFollowsPointer || !result.previewAboveTimeline ||
  !result.thumbHoverCenterStable || !result.timelineClickSoughtOnce || !result.localSeekStayedPlaying || !result.localSeekAvoidedLoader || !result.immediateSeekFrameShown || !result.thumbPressDidNotJump || !result.thumbDragDeferredUntilRelease || !result.thumbDragPreservedGrabOffset || !result.volumeDragged || !result.modalPausedPlayback || !result.modalBlockedSpaceResume || !result.modalStayedPausedAfterClose || !result.brandedLoadingUi || !result.localWaitingAvoidedLoader || !result.loaderHiddenAfterCanPlay || !result.compatibilityFallbackPlayable ||
  !result.previousSubtitleCleared ||
  !result.staticSubtitleCardHidden || !result.dictionaryCardHidden
) {
  process.exitCode = 1;
}

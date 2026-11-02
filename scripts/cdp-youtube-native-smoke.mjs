import { connectPlayer } from "./cdp-connection.mjs";

const player = await connectPlayer();
const url = process.argv[2] || "https://www.youtube.com/watch?v=NHQH5Y_zW_E";
const quality = process.env.LINGO_YOUTUBE_QUALITY || "1080";
const steadySeconds = Number(process.env.LINGO_STEADY_SECONDS || 60);
async function run(url, quality, steadySeconds) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stage = (text) => console.log("[YT-NATIVE] " + text);
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const yt = window.__LINGO_YOUTUBE_TEST__;
  const local = window.__LINGO_NATIVE_TEST__;
  const wait = async (test, label, timeout = 60000) => {
    const start = performance.now();
    while (!test()) {
      if (performance.now() - start > timeout) throw new Error(label + ": " + JSON.stringify(yt.snapshot()));
      await sleep(100);
    }
    return Math.round(performance.now() - start);
  };
  const ready = () => {
    const state = yt.snapshot();
    return state.backend === "mpv" && state.native.fileLoaded && state.native.firstFrameAt && !state.native.seeking && !state.native.pausedForCache;
  };
  const oldSettings = localStorage.getItem("player-settings");
  const oldProgress = localStorage.getItem("playback-progress-v1");
  try {
    await wait(() => document.body.dataset.persistenceReady === "true", "persistence hydration");
    local.restoreProgressStorage(null);
    const setting = document.querySelector("#setting-youtube-quality");
    setting.value = quality;
    setting.dispatchEvent(new Event("change", { bubbles: true }));
    window.openModal("youtube-modal");
    document.querySelector("#yt-url-field").value = url;
    const lookupStart = performance.now();
    document.querySelector("#yt-find-button").click();
    await wait(() => !document.querySelector("#yt-find-button").disabled, "lookup", 90000);
    assert(!document.querySelector("#yt-play-button").disabled, document.querySelector("#yt-status").textContent);
    const lookupMs = Math.round(performance.now() - lookupStart);
    stage("resolved in " + lookupMs + " ms");
    document.querySelector("#yt-play-button").click();
    const startupMs = await wait(ready, "native startup");
    stage("native playback started in " + startupMs + " ms");
    assert(!document.querySelector("#native-video").hasAttribute("src") && !document.querySelector("#youtube-audio").hasAttribute("src"), "WebView must not download/play competing streams");
    assert(!document.querySelector("video.lp-preview-source").hasAttribute("src"), "Preview must stay dormant");
    const initial = yt.snapshot();
    const audioTracks = [];
    const trackCount = await yt.nativeProperty("track-list/count", "int64");
    for (let i = 0; i < trackCount; i++) {
      audioTracks.push({
        type: await yt.nativeProperty(`track-list/${i}/type`, "string"),
        selected: await yt.nativeProperty(`track-list/${i}/selected`, "flag")
      });
    }
    assert(audioTracks.some((track) => track.type === "audio" && track.selected), "Native audio track must actually be selected");
    assert(audioTracks.some((track) => track.type === "video" && track.selected), "Native video track must actually be selected");
    let maxDrift = 0, rebufferSamples = 0, backwardJumps = 0;
    let previousTime = initial.currentTime;
    const steadyStart = performance.now();
    while (performance.now() - steadyStart < steadySeconds * 1000 && yt.snapshot().duration - yt.snapshot().currentTime > 2) {
      await sleep(200);
      const state = yt.snapshot();
      if (state.native.pausedForCache) rebufferSamples++;
      if (state.currentTime < previousTime - .12) backwardJumps++;
      if (!state.native.pausedForCache && !state.native.seeking) maxDrift = Math.max(maxDrift, Math.abs(state.native.avSync || 0));
      previousTime = state.currentTime;
    }
    const steadyProgress = yt.snapshot().currentTime - initial.currentTime;
    stage("steady playback " + JSON.stringify({ steadyProgress, maxDrift, rebufferSamples, backwardJumps }));
    assert(backwardJumps === 0, "Unexpected backward jump during steady playback");
    assert(maxDrift < .15, "Steady A/V drift exceeds 150ms");
    assert(steadyProgress > Math.min(steadySeconds * .85, initial.duration - initial.currentTime - 3), "Playback made insufficient progress");
    local.setVolume(.35);
    document.querySelector('[title="Mute/Unmute"]').click();
    await wait(() => local.snapshot().muted, "mute");
    document.querySelector('[title="Mute/Unmute"]').click();
    document.querySelector('[title="Playback Speed"]').click();
    await sleep(1500);
    const selectedSpeed = await yt.nativeProperty("speed");
    assert(selectedSpeed !== 1 && Math.abs(yt.snapshot().native.avSync || 0) < .15, "Speed change must preserve A/V synchronization");
    const seeks = [];
    for (const ratio of [.76, .24, .62, .05]) {
      const target = initial.duration * ratio;
      yt.seek(target);
      const milliseconds = await wait(() => ready() && Math.abs(yt.snapshot().currentTime - target) < 2, "seek " + ratio);
      await sleep(700);
      const drift = Math.abs(yt.snapshot().native.avSync || 0);
      assert(drift < .15, "A/V drift after seek " + ratio);
      seeks.push({ ratio, milliseconds, drift });
      stage("seek " + JSON.stringify(seeks.at(-1)));
    }
    for (let n = 0; n < 12; n++) { yt.seek(initial.duration * (.1 + n * .045)); await sleep(35); }
    const burstTarget = initial.duration * .595;
    await wait(() => ready() && Math.abs(yt.snapshot().currentTime - burstTarget) < 3, "rapid seek burst");
    yt.pause();
    await wait(() => yt.snapshot().paused, "pause");
    const pausedTime = yt.snapshot().currentTime;
    await sleep(800);
    assert(Math.abs(yt.snapshot().currentTime - pausedTime) < .2, "Pause must stop the shared clock");
    const options = yt.snapshot().formats;
    const alternate = options.findIndex((format) => format.height !== initial.selectedFormatHeight);
    assert(alternate >= 0, "Expected another real video quality");
    yt.switchFormat(alternate);
    await wait(ready, "paused quality switch");
    assert(yt.snapshot().paused && Math.abs(yt.snapshot().currentTime - pausedTime) < 1, "Quality switch must preserve pause/time");
    const switchedVolume = yt.snapshot().volume;
    const switchedSpeed = await yt.nativeProperty("speed");
    stage("quality preservation " + JSON.stringify({ expectedVolume: .35, switchedVolume, selectedSpeed, switchedSpeed }));
    assert(Math.abs(switchedVolume - .35) < .01 && Math.abs(switchedSpeed - selectedSpeed) < .001, "Quality switch must preserve volume and speed");
    await yt.play();
    await wait(() => ready() && yt.snapshot().currentTime > pausedTime + .5, "resume");
    const beforeRecovery = yt.snapshot().currentTime;
    await yt.recover({ forceRefresh: true });
    await wait(() => ready() && yt.snapshot().currentTime >= beforeRecovery - .5, "signed URL refresh", 90000);
    assert(yt.snapshot().selectedAudioTrackId === initial.selectedAudioTrackId, "Refresh must preserve audio selection");
    const range = await fetch(yt.snapshot().videoUrl, { headers: { Range: "bytes=100-1123" }, signal: AbortSignal.timeout(20000) });
    const bytes = await range.arrayBuffer();
    assert(range.status === 206 && bytes.byteLength === 1024, "Video byte Range is invalid");
    const captionDeadline = performance.now() + 15000;
    while (!document.querySelector("[data-subtitle-track]") && performance.now() < captionDeadline) await sleep(100);
    const captionsLoaded = document.querySelectorAll("[data-subtitle-track]").length;
    if (initial.lookupCaptionCount) assert(captionsLoaded > 0, "YouTube captions should remain available");
    const timeline = document.querySelector(".yt-scrub-track");
    const rect = timeline.getBoundingClientRect();
    timeline.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + rect.width * .35, clientY: rect.top + 2, bubbles: true }));
    await wait(() => local.snapshot().previewFrames > 0, "timeline preview", 30000);
    await wait(() => !document.querySelector("video.lp-preview-source").hasAttribute("src"), "preview decoder must release the network");
    timeline.dispatchEvent(new PointerEvent("pointerleave"));
    yt.seek(Math.max(0, initial.duration - 1));
    await wait(() => yt.snapshot().native.eof || !yt.snapshot().playbackWanted, "end of video", 30000);
    await yt.play();
    await wait(() => ready() && yt.snapshot().currentTime < 5 && yt.snapshot().currentTime > 0, "replay after EOF");
    return { url, quality, lookupMs, startupMs, selectedHeight: initial.selectedFormatHeight, steadyProgress, maxDrift, rebufferSamples, backwardJumps, seeks, burst: true, pausedQualitySwitch: true, volumeSpeedPreserved: true, refresh: true, range: true, captionsLoaded, previewReleased: true, replay: true };
  } finally {
    yt.pause();
    if (oldSettings == null) localStorage.removeItem("player-settings"); else localStorage.setItem("player-settings", oldSettings);
    local.restoreProgressStorage(oldProgress);
  }
}
try {
  await player.reload();
  console.log(JSON.stringify(await player.evaluate(`(${run})(${JSON.stringify(url)},${JSON.stringify(quality)},${steadySeconds})`, 600000), null, 2));
} finally { player.close(); }

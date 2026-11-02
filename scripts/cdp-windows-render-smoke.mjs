// Run against an isolated development app. Exercise the actual native window,
// including maximized and paused playback; the old tests checked flags only.
import assert from "node:assert/strict";
import { connectPlayer } from "./cdp-connection.mjs";

const [videoPath, sparsePath, hevcPath] = process.argv.slice(2);
if (!videoPath || !sparsePath || !hevcPath) throw new Error("Pass a long video, low-frame-rate video, and 10-bit HEVC MKV.");
const player = await connectPlayer();
try {
  await player.reload();
  const result = await player.evaluate(`(async () => {
    const api = window.__LINGO_NATIVE_TEST__;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async predicate => {
      const deadline = performance.now() + 8000;
      while (!await predicate()) {
        if (performance.now() > deadline) throw new Error('Timed out: ' + predicate.toString());
        await wait(15);
      }
    };
    await until(() => document.body.dataset.persistenceReady === 'true');
    const win = (name, parameters = {}) => window.__TAURI_INTERNALS__.invoke('plugin:window|' + name, { label: 'main', ...parameters });
    if (await win('is_fullscreen')) { await window.__TAURI_INTERNALS__.invoke('set_player_fullscreen', { fullscreen: false }); await wait(400); }
    if (await win('is_maximized')) { await win('toggle_maximize'); await wait(400); }
    const output = () => window.__LINGO_YOUTUBE_TEST__.nativeProperty('vo-configured', 'flag');
    const open = async path => {
      await api.open(path);
      await until(() => api.snapshot().videoVisible && api.snapshot().width > 0);
      await wait(1200);
      return { ...api.snapshot(), vo: await window.__LINGO_YOUTUBE_TEST__.nativeProperty('current-vo', 'string'), hwdec: await window.__LINGO_YOUTUBE_TEST__.nativeProperty('hwdec-current', 'string') };
    };
    api.setVolume(0);
    const loaded = await open(${JSON.stringify(videoPath)});
    const button = document.querySelector('[title="Fullscreen (F)"]');
    const events = [];
    const onResize = () => events.push({ w: innerWidth, h: innerHeight });
    addEventListener('resize', onResize);
    const cycles = [];
    const chrome = () => ['#top-chrome', '#bottom-chrome'].map(selector => {
      const element = document.querySelector(selector), rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      return { opacity: Number(getComputedStyle(element).opacity), top: rect.top, bottom: rect.bottom, height: rect.height,
        hit: Boolean(document.elementFromPoint(x, y)?.closest(selector)) };
    });
    const normal = { w: innerWidth, h: innerHeight };
    for (const maximized of [false, true]) {
      if (await win('is_maximized') !== maximized) { await win('toggle_maximize'); await wait(400); }
      for (const paused of [false, true]) {
        if (paused) api.pause(); else await api.play();
        for (let cycle = 0; cycle < 3; cycle++) {
          events.length = 0;
          const start = performance.now();
          button.click();
          await until(async () => await win('is_fullscreen') && !api.snapshot().windowTransitioning);
          const enterMs = Math.round(performance.now() - start);
          await wait(480);
          const entered = { w: innerWidth, h: innerHeight, chrome: chrome(), output: await output(), paused: api.snapshot().paused };
          // Native focus changes and mouseleave during a window transition
          // must not leave the controls hidden after it settles.
          dispatchEvent(new Event('blur'));
          document.dispatchEvent(new Event('mouseleave'));
          const exitStart = performance.now();
          button.click();
          await until(async () => !await win('is_fullscreen') && !api.snapshot().windowTransitioning);
          const exitMs = Math.round(performance.now() - exitStart);
          await wait(480);
          cycles.push({ maximized, paused, enterMs, exitMs, entered,
            exited: { maximized: await win('is_maximized'), chrome: chrome(), output: await output(), paused: api.snapshot().paused },
            resizedThroughNormal: maximized && events.some(size => size.w === normal.w && size.h === normal.h) });
        }
      }
    }
    removeEventListener('resize', onResize);
    if (await win('is_maximized')) { await win('toggle_maximize'); await wait(400); }
    for (let index = 0; index < 6; index++) button.click();
    await until(async () => !api.snapshot().windowTransitioning && !await win('is_fullscreen'));
    const rapidFullscreen = { fullscreen: await win('is_fullscreen'), output: await output() };
    const hevc = await open(${JSON.stringify(hevcPath)});
    const sparse = await open(${JSON.stringify(sparsePath)});
    api.seek(sparse.duration - 1.3);
    await api.play();
    await until(() => api.snapshot().eof && api.snapshot().endFrameLoaded);
    const track = document.querySelector('.yt-scrub-track');
    const fill = track.firstElementChild.lastElementChild;
    const eof = { ...api.snapshot(), fill: fill.style.width, thumb: track.querySelector('.yt-thumb').style.left,
      bodyBackground: getComputedStyle(document.body).backgroundColor };
    const shades = ['#top-chrome', '#bottom-chrome', '.lp-video-shade-top', '.lp-video-shade-bottom'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundImage);
    await api.play();
    await until(() => !api.snapshot().eof && api.snapshot().videoVisible);
    api.pause();
    return { loaded, cycles, rapidFullscreen, hevc, eof, replay: api.snapshot(), shades };
  })()`);
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.loaded.vo, "gpu");
  assert.equal(result.loaded.rendererMode, "accelerated");
  for (const cycle of result.cycles) {
    assert.ok(cycle.enterMs < 1500 && cycle.exitMs < 1500, "Window transition stalled");
    assert.equal(cycle.entered.h, await player.evaluate("screen.height"), "Fullscreen must cover the taskbar");
    assert.equal(cycle.exited.maximized, cycle.maximized);
    assert.equal(cycle.resizedThroughNormal, false, "Maximized/fullscreen transition exposed the normal-size window");
    for (const phase of [cycle.entered, cycle.exited]) {
      assert.equal(phase.output, true);
      assert.equal(phase.paused, cycle.paused);
      assert.ok(phase.chrome.every(control => control.opacity > .99 && control.hit), "Controls disappeared or lost hit testing");
    }
  }
  assert.equal(result.hevc.vo, "gpu");
  assert.deepEqual(result.rapidFullscreen, { fullscreen: false, output: true });
  assert.equal(result.hevc.rendererMode, "accelerated");
  assert.ok(result.hevc.width > 0 && result.hevc.videoVisible);
  assert.equal(result.eof.fill, "100%");
  assert.equal(result.eof.thumb, "100%");
  assert.equal(result.eof.videoVisible, false);
  assert.equal(result.eof.endFrameVisible, true);
  assert.notEqual(result.eof.bodyBackground, "rgba(0, 0, 0, 0)");
  assert.equal(result.replay.videoVisible, true);
  assert.equal(result.replay.endFrameVisible, false);
  assert.ok(result.shades.every(shade => !/rgba?\((?!0, 0, 0[,\)])/g.test(shade)), "Chrome shading must use black RGB values");
  console.log("Windows rendering/fullscreen/EOF regression passed");
} finally {
  player.close();
}

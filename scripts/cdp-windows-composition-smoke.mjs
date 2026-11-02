// Capture the app's compositor surface, including native mpv, even when the
// player is behind another app. CDP/GDI screenshots omit GPU child surfaces.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectPlayer } from "./cdp-connection.mjs";

const whiteVideo = process.argv[2];
if (!whiteVideo) throw new Error("Pass an all-white local video fixture.");
const directory = process.env.LINGO_RENDER_ARTIFACT_DIR || join(tmpdir(), `lingo-composition-${Date.now()}`);
await mkdir(directory, { recursive: true });
const ffmpeg = join(process.cwd(), "src-tauri/binaries/ffmpeg.exe");
const ffprobe = join(process.cwd(), "src-tauri/binaries/ffprobe.exe");
const player = await connectPlayer();
const run = (file, args, extra = {}) => execFileSync(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 20000, ...extra });
const capture = async name => {
  await player.evaluate(`document.querySelector('#bottom-chrome').dispatchEvent(new PointerEvent('pointerenter'))`);
  await new Promise(resolve => setTimeout(resolve, 500));
  const path = join(directory, `${name}.png`);
  // A paused, fully occluded fullscreen window may not submit another DWM
  // frame. Dirty one corner pixel while WGC attaches; sampled areas are clear.
  await player.evaluate(`(()=>{
    const marker=document.createElement('div');marker.id='composition-capture-tick';
    marker.style.cssText='position:fixed;left:2px;top:2px;width:1px;height:1px;z-index:10000;background:white';
    document.body.append(marker);let tick=false;
    window.__compositionCaptureTick=setInterval(()=>{tick=!tick;marker.style.opacity=tick?'0.1':'0.2'},80);
  })()`);
  try {
    run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      "gfxcapture=window_title=^Rupelian Player$:window_exe=^rupelian.exe$:capture_cursor=0",
      "-vf", "hwdownload,format=bgra", "-frames:v", "1", "-update", "1", path]);
  } finally {
    await player.evaluate(`clearInterval(window.__compositionCaptureTick);document.querySelector('#composition-capture-tick')?.remove()`);
  }
  const { width, height } = JSON.parse(run(ffprobe, ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", path])).streams[0];
  const pixels = run(ffmpeg, ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  const pixel = (x, y) => [...pixels.subarray((Math.floor(y * height) * width + Math.floor(x * width)) * 4, (Math.floor(y * height) * width + Math.floor(x * width)) * 4 + 4)];
  return { path, width, height, center: pixel(.5, .5), header: pixel(.5, .02), bottom: pixel(.15, .985) };
};
try {
  await player.reload();
  await player.evaluate(`(async()=>{
    if(await window.__TAURI_INTERNALS__.invoke('plugin:window|is_fullscreen',{label:'main'}))
      await window.__TAURI_INTERNALS__.invoke('set_player_fullscreen',{fullscreen:false});
    if(await window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized',{label:'main'}))
      await window.__TAURI_INTERNALS__.invoke('plugin:window|toggle_maximize',{label:'main'});
    await window.__LINGO_NATIVE_TEST__.open(${JSON.stringify(whiteVideo)});
    const deadline=performance.now()+8000;
    while(!window.__LINGO_NATIVE_TEST__.snapshot().videoVisible){if(performance.now()>deadline)throw new Error('No native picture');await new Promise(r=>setTimeout(r,25));}
    window.__LINGO_NATIVE_TEST__.pause();
  })()`);
  const normal = await capture("normal");
  const toggle = async () => {
    await player.evaluate(`document.querySelector('[title="Fullscreen (F)"]').click()`);
    const deadline = Date.now() + 6000;
    while (await player.evaluate("window.__LINGO_NATIVE_TEST__.snapshot().windowTransitioning")) {
      if (Date.now() > deadline) throw new Error("Fullscreen transition stalled");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await toggle();
  const fullscreen = await capture("fullscreen");
  await toggle();
  // Deliberately remove the native child while leaving the WebView transparent.
  // An opaque desktop host must still return solid black with alpha=255.
  await player.evaluate(`(async()=>{
    await window.__TAURI_INTERNALS__.invoke('plugin:libmpv|destroy',{windowLabel:'main'});
    document.querySelector('.lp-seek-preview').classList.add('lp-hidden');
    document.body.classList.add('lp-native-video-visible');
  })()`);
  const missingNative = await capture("missing-native");
  const report = { normal, fullscreen, missingNative };
  await writeFile(join(directory, "composition.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const surface of [normal, fullscreen]) {
    assert.ok(surface.center.slice(0, 3).every(value => value >= 245), "The real native white frame was not composed");
    assert.equal(surface.center[3], 255);
    assert.ok(surface.header.slice(0, 3).every(value => value < 25), "Header is gray instead of black");
    assert.ok(surface.bottom.slice(0, 3).every(value => value < 25), "Bottom chrome is gray instead of black");
  }
  assert.deepEqual(missingNative.center, [0, 0, 0, 255], "A missing native picture exposed the desktop or transparent pixels");
  console.log("Windows compositor pixels passed");
} finally {
  // Recreate mpv after the deliberate output failure; do not leave the app in
  // an artificial failure state after either a success or an assertion error.
  await player.evaluate(`window.__TAURI_INTERNALS__.invoke('set_player_fullscreen',{fullscreen:false})`).catch(() => {});
  await player.reload();
  player.close();
}

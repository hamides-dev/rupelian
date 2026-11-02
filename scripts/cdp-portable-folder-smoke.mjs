import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectPlayer } from './cdp-connection.mjs';

const path = process.argv[2];
if (!path) throw new Error('Pass a local video fixture path');

const executable = process.env.LINGO_PORTABLE_EXE;
const port = process.env.LINGO_CDP_PORT || '9242';
let child;
let directory;
let childLog = '';
let player;
let stage = 'startup';
try {
  if (executable) {
    directory = await mkdtemp(join(tmpdir(), 'lingo-portable-folder-check-'));
    child = spawn(resolve(executable), [path], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        LINGO_CDP_PORT: port,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
        WEBVIEW2_USER_DATA_FOLDER: join(directory, 'webview'),
        LINGO_CINEMA_DATA_DIR: join(directory, 'data')
      }
    });
    child.stderr.on('data', data => { childLog += data; });
    const deadline = Date.now() + 30000;
    while (true) {
      if (child.exitCode != null) throw new Error(`Packaged app exited before CDP was ready (${child.exitCode}): ${childLog}`);
      const ready = await fetch(`http://127.0.0.1:${port}/json`)
        .then(response => response.json())
        .then(pages => pages.some(page => /tauri\.localhost|^tauri:/.test(page.url)))
        .catch(() => false);
      if (ready) break;
      if (Date.now() > deadline) throw new Error(`Packaged app did not expose its main CDP page: ${childLog}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  const deadline = Date.now() + 30000;
  while (!player && Date.now() < deadline) {
    player = await connectPlayer().catch(() => null);
    if (!player) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(player, 'Packaged app did not expose a stable WebView');

  stage = 'playback';
  const expectedPath = path.replaceAll('\\', '/').toLowerCase();
  let playback;
  while (Date.now() < deadline) {
    playback = await player.evaluate(`Promise.all([
      window.__TAURI_INTERNALS__.invoke('plugin:libmpv|get_property',{name:'path',format:'string',windowLabel:'main'}),
      window.__TAURI_INTERNALS__.invoke('plugin:libmpv|get_property',{name:'time-pos',format:'double',windowLabel:'main'}),
      window.__TAURI_INTERNALS__.invoke('plugin:libmpv|get_property',{name:'duration',format:'double',windowLabel:'main'})
    ]).then(([path,time,duration])=>({path,time,duration,origin:location.origin}))`).catch(() => null);
    if (playback?.path?.replaceAll('\\', '/').toLowerCase() === expectedPath && playback.time > .3) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(playback?.path?.replaceAll('\\', '/').toLowerCase(), expectedPath, 'Startup video path was not opened');
  assert(playback.time > .3, 'Packaged local playback did not advance');

  stage = 'seek';
  await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:libmpv|command',{name:'seek',args:[40,'absolute+exact'],windowLabel:'main'})`);
  let seekPosition;
  const seekDeadline = Date.now() + 10000;
  while (Date.now() < seekDeadline) {
    seekPosition = await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:libmpv|get_property',{name:'time-pos',format:'double',windowLabel:'main'})`).catch(() => null);
    if (Math.abs(seekPosition - 40) < 2) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(Math.abs(seekPosition - 40) < 2, 'Packaged local seek failed');

  stage = 'helpers';
  const helpers = await player.evaluate(`Promise.all([
    window.__TAURI_INTERNALS__.invoke('prepare_local_preview',{path:${JSON.stringify(path)},seconds:17.321}),
    window.__TAURI_INTERNALS__.invoke('discover_embedded_subtitles',{path:${JSON.stringify(path)}})
  ]).then(([preview,probe])=>({preview:Boolean(preview),probe:Array.isArray(probe)}))`, 60000);
  const result = {origin:playback.origin,duration:playback.duration,preview:helpers.preview,probe:helpers.probe};
  stage = 'complete';
  assert.match(result.origin, /^https?:\/\/tauri\.localhost/);
  assert(result.duration > 40, 'Packaged local video duration was not detected');
  assert(result.preview, 'Packaged FFmpeg preview generation failed');
  assert(result.probe, 'Packaged FFprobe discovery failed');
  console.log(JSON.stringify({passed:true,...result}, null, 2));
  await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|close', {label:'main'})`).catch(() => {});
} catch (error) {
  throw new Error(`Portable folder smoke failed during ${stage}: ${error.message}`);
} finally {
  player?.close();
  if (child && child.exitCode == null) {
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);
    if (child.exitCode == null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
    }
  }
  if (directory && directory.startsWith(join(tmpdir(), 'lingo-portable-folder-check-'))) {
    await new Promise(resolve => setTimeout(resolve, 500));
    await rm(directory, {recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
}

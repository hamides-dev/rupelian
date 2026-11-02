import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile, open, stat, mkdtemp, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectPlayer } from './cdp-connection.mjs';

const executable = resolve(process.argv[2]);
const fixture = resolve(process.argv[3]);
const size = (await stat(executable)).size;
const file = await open(executable);
const footer = Buffer.alloc(104);
try { await file.read(footer, 0, 104, size - 104); } finally { await file.close(); }
assert.equal(footer.subarray(0, 16).toString(), 'LINGOCINEMAPKG01');
assert.equal(Number(footer.readBigUInt64LE(16) + footer.readBigUInt64LE(24) + footer.readBigUInt64LE(32)) + 104, size);
assert.ok(footer.readBigUInt64LE(16) < 1024n * 1024n);
const hash = footer.subarray(40).toString();
const cache = join(process.env.LOCALAPPDATA, 'Rupelian', 'portable-runtime', hash);
const marker = join(cache, 'complete');
assert.equal(await readFile(marker, 'utf8'), hash, 'Run the first-launch benchmark first');
const before = (await stat(marker)).mtimeMs;
process.env.LINGO_CDP_PORT ||= '9239';
const port = process.env.LINGO_CDP_PORT;
assert.equal(await fetch(`http://127.0.0.1:${port}/json`).then(()=>true,()=>false), false);
const directory = await mkdtemp(join(tmpdir(), 'lingo-portable-check-'));
const child = spawn(executable, [fixture], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  WEBVIEW2_USER_DATA_FOLDER: join(directory, 'webview'), LINGO_CINEMA_DATA_DIR: directory
} });
const exited = new Promise(resolve => child.once('exit', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let player;
try {
  const deadline = Date.now() + 30000;
  while (!player && Date.now() < deadline) { player = await connectPlayer().catch(()=>null); if (!player) await delay(100); }
  assert.ok(player, 'The portable player did not open');
  let startupPath;
  while (Date.now() < deadline) {
    startupPath = await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:libmpv|get_property', {name:'path',format:'string',windowLabel:'main'})`).catch(()=>null);
    if (startupPath?.replaceAll('\\','/').toLowerCase() === fixture.replaceAll('\\','/').toLowerCase()) break;
    await delay(100);
  }
  assert.equal(startupPath?.replaceAll('\\','/').toLowerCase(), fixture.replaceAll('\\','/').toLowerCase(), 'Startup file argument was lost');
  const sizeAfterHandoff = await player.evaluate('({width:innerWidth,height:innerHeight})');
  assert.deepEqual(sizeAfterHandoff, {width:1180,height:720}, 'Handoff changed the player dimensions');
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
    `(Get-Process -Id ${child.pid}).Modules.FileName | ConvertTo-Json -Compress`], {windowsHide:true, timeout:10000});
  const modules = JSON.parse(result.stdout);
  for (const name of ['rupelian_lib.dll', 'libmpv-wrapper.dll', 'libmpv-2.dll', 'vcruntime140.dll', 'vulkan-1.dll']) {
    assert.ok(modules.some(path => path.toLowerCase().startsWith(cache.toLowerCase()) && path.toLowerCase().endsWith(name)), `${name} must come from the package cache`);
  }
  // Production builds omit development test hooks; exercise real controls.
  const windowChecks = await player.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
    const state = async () => ({fullscreen:await invoke('plugin:window|is_fullscreen',{label:'main'}),maximized:await invoke('plugin:window|is_maximized',{label:'main'}),width:innerWidth,height:innerHeight});
    await invoke('plugin:window|toggle_maximize',{label:'main'}); await sleep(600);
    document.querySelector('[title="Fullscreen (F)"]').click(); await sleep(800);
    const fullscreen = await state();
    document.querySelector('[title="Fullscreen (F)"]').click(); await sleep(800);
    const restoredMaximized = await state();
    await invoke('plugin:window|toggle_maximize',{label:'main'}); await sleep(600);
    document.querySelector('#native-video').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true})); await sleep(700);
    const doubleClickFullscreen = await state();
    document.querySelector('#native-video').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true})); await sleep(700);
    return {fullscreen,restoredMaximized,doubleClickFullscreen,restored:await state()};
  })()`);
  assert.equal(windowChecks.fullscreen.fullscreen,true);
  assert.equal(windowChecks.restoredMaximized.maximized,true);
  assert.equal(windowChecks.doubleClickFullscreen.fullscreen,true);
  assert.deepEqual(windowChecks.restored,{fullscreen:false,maximized:false,width:1180,height:720});
  const smoke = await promisify(execFile)(process.execPath, ['scripts/cdp-portable-smoke.mjs', fixture], {windowsHide:true, timeout:240000, env:process.env});
  console.log(smoke.stdout);
  assert.equal((await stat(marker)).mtimeMs, before, 'Cached launch unexpectedly re-extracted components');
  assert.equal(await stat(join(cache,'unpack.exe')).then(()=>true,()=>false), false);
  assert.equal(await stat(join(cache,'payload.7z')).then(()=>true,()=>false), false);
  const report = {passed:true, executable, bytes:size, entryExeBytes:Number(footer.readBigUInt64LE(16)), cache,
    cacheReused:true, startupFileOpened:true, sizeAfterHandoff, window:windowChecks, runtimeModules:modules.filter(path=>path.toLowerCase().startsWith(cache.toLowerCase())), playback:JSON.parse(smoke.stdout)};
  console.log(JSON.stringify(report,null,2));
  if(process.argv[4]) await writeFile(process.argv[4],JSON.stringify(report,null,2)+'\n');
} finally {
  if(player) { await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})`).catch(()=>{}); player.close(); }
  await Promise.race([exited,delay(5000)]);
  if(child.exitCode===null) child.kill();
}

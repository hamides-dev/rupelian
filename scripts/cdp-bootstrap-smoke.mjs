import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { connectPlayer } from "./cdp-connection.mjs";

const executable = process.argv[2];
if (!executable) throw new Error('Pass the isolated development executable');
const entryExeBytes = (await stat(executable)).size;
assert.ok(entryExeBytes < 1024 * 1024, 'The entry EXE should remain below 1 MiB');
process.env.LINGO_CDP_PORT ||= '9238';
const port = process.env.LINGO_CDP_PORT;
assert.equal(await fetch(`http://127.0.0.1:${port}/json`).then(() => true, () => false), false, 'Use an unoccupied test port');
const directory = await mkdtemp(join(tmpdir(), 'lingo-bootstrap-'));
const image = join(directory, 'native-startup.bmp');
const launchedAt = Date.now();
const child = spawn(resolve(executable), [], {
  windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    LINGO_CINEMA_DATA_DIR: directory, WEBVIEW2_USER_DATA_FOLDER: join(directory, 'webview'), LINGO_BOOTSTRAP_TRACE: '1',
    LINGO_BOOTSTRAP_TEST_DELAY_MS: '6000', LINGO_BOOTSTRAP_TEST_IMAGE: image }
});
let log = '';
child.stderr.on('data', data => { log += data; });
let launchError;
child.on('error', error => { launchError = error; });
const exited = new Promise(resolve => child.once('exit', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let player;
try {
  const deadline = Date.now() + 25000;
  while (!log.includes('LINGO_BOOTSTRAP_PAINT ') && Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Bootstrap exited early: ${log}`);
    await delay(10);
  }
  const paintLine = log.split(/\r?\n/).find(line => line.startsWith('LINGO_BOOTSTRAP_PAINT '));
  assert.ok(paintLine, 'The native window must paint before anything else');
  const paint = JSON.parse(paintLine.slice('LINGO_BOOTSTRAP_PAINT '.length));
  // Read module names only; no UI injection or third-party process inspection.
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
    `(Get-Process -Id ${child.pid}).Modules.ModuleName | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 5000 });
  const modules = JSON.parse(stdout);
  assert.ok(!modules.some(name => /rupelian_lib|webview|libmpv|sqlite/i.test(name)), 'Heavy runtime loaded before the native loading surface');
  while (!log.includes('LINGO_BOOTSTRAP_HEARTBEAT') && Date.now() < deadline) await delay(20);
  const heartbeat = Number(log.match(/LINGO_BOOTSTRAP_HEARTBEAT (\d+)/)?.[1]);
  assert.ok(heartbeat > paint.firstVisibleUnixMs, 'Native message loop must stay alive while DLL loading is paused');
  while (!player && Date.now() < deadline) {
    player = await connectPlayer().catch(() => null);
    if (!player) await delay(50);
  }
  assert.ok(player, `The runtime did not take over after the deliberate delay: ${log.slice(-4000)}`);
  let startup;
  while (Date.now() < deadline) {
    startup = await player.evaluate('window.__LINGO_STARTUP__');
    if (startup?.nativePlayerReadyAt && startup?.nativeStartup) break;
    await delay(50);
  }
  const native = startup.nativeStartup;
  assert.ok(native.runtimeLoadStartedUnixMs - native.firstVisibleUnixMs >= 5900);
  assert.ok(heartbeat < native.runtimeLoadStartedUnixMs, 'The native heartbeat must precede DLL loading');
  assert.ok(native.runtimeStartedUnixMs >= native.runtimeLoadStartedUnixMs);
  assert.equal(await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', {label:'main'})`), true);
  assert.equal(await player.evaluate(`document.body.dataset.nativePlayerReady`), 'true');
  assert.deepEqual(await player.evaluate('({width:innerWidth,height:innerHeight})'), {width:1180,height:720}, 'Handoff changed the player dimensions');
  // A second click must forward into this instance without flashing a cover.
  const forwarded = spawn(resolve(executable), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LINGO_BOOTSTRAP_TRACE:'1' } });
  let secondLog = '';
  forwarded.stderr.on('data', chunk => { secondLog += chunk; });
  const secondExit = await Promise.race([new Promise(resolve => forwarded.once('exit', resolve)), delay(10000).then(() => { forwarded.kill(); return 'timeout'; })]);
  assert.equal(secondExit, 0, 'Second instance did not forward');
  assert.ok(!secondLog.includes('LINGO_BOOTSTRAP_PAINT'), 'Second click flashed another loading window');
  const cancelStart = Date.now();
  // A fresh instance is needed to exercise cancelling before any DLL loads.
  await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|close', {label:'main'})`).catch(()=>{});
  player.close(); player = null;
  await exited;
  const cancelled = spawn(resolve(executable), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, LINGO_BOOTSTRAP_TRACE:'1', LINGO_BOOTSTRAP_TEST_DELAY_MS:'6000', LINGO_BOOTSTRAP_TEST_CANCEL_MS:'400' } });
  let cancelLog = '';
  cancelled.stderr.on('data', chunk => { cancelLog += chunk; });
  const cancelExit = await Promise.race([new Promise(resolve => cancelled.once('exit', resolve)), delay(4000).then(()=> { cancelled.kill(); return 'timeout'; })]);
  assert.equal(cancelExit, 0, 'Closing the loading window must exit promptly');
  assert.ok(cancelLog.includes('LINGO_BOOTSTRAP_PAINT'), 'Cancel test never painted');
  const report = { passed:true, entryExeBytes, launchToNativeLoadingWindowMs: paint.firstVisibleUnixMs - launchedAt,
    firstVisibleAfterEntryMs: paint.firstVisibleAfterEntryMs, heavyModulesAbsentAtFirstPaint:true,
    nativeHeartbeatBeforeRuntime:true, secondClickForwarded:true, cancelDuringLoadingMs:Date.now()-cancelStart, image, startup };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2)+'\n');
} finally {
  if (player) {
    await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|close', {label:'main'})`).catch(()=>{});
    player.close();
  }
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null) child.kill();
}

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectPlayer } from "./cdp-connection.mjs";

// Prefer an isolated development identifier. A requested portable package may
// also be measured, only when no normal player instance is already running.
const executable = process.argv[2];
if (!executable) throw new Error("Usage: node scripts/benchmark-startup.mjs <development-exe> [runs] [report.json]");
const runs = Number(process.argv[3] || 3);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("Use 1–10 runs");
const port = process.env.LINGO_CDP_PORT || "9237";
process.env.LINGO_CDP_PORT = port;
if (await fetch(`http://127.0.0.1:${port}/json`).then(() => true, () => false)) {
  throw new Error(`Debugging port ${port} is already occupied`);
}
const dataDir = await mkdtemp(join(tmpdir(), "lingo-startup-test-"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
for (let run = 1; run <= runs; run++) {
  let player;
  const launchedAt = Date.now();
  const child = spawn(resolve(executable), [], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      LINGO_CINEMA_DATA_DIR: dataDir,
      WEBVIEW2_USER_DATA_FOLDER: join(dataDir, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
    }
  });
  let launchError;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.on("error", (error) => { launchError = error; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const deadline = launchedAt + Number(process.env.LINGO_STARTUP_TIMEOUT_MS || 20000);
    while (!player && Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Player exited (${child.exitCode}) before opening: ${stderr}`);
      player = await connectPlayer().catch(() => null);
      if (!player) await delay(25);
    }
    if (!player) throw new Error("No player window before the startup deadline");
    let snapshot;
    while (Date.now() < deadline) {
      snapshot = await player.evaluate(`({
        timeOrigin: performance.timeOrigin,
        ...window.__LINGO_STARTUP__,
        overlayPresent: Boolean(document.querySelector('#startup-shell')),
        shellReady: document.body?.dataset.shellReady,
        nativeReady: document.body?.dataset.nativePlayerReady,
        error: document.body?.dataset.playerInitializationError,
        paint: performance.getEntriesByType('paint').map(({ name, startTime }) => ({ name, startTime }))
      })`);
      if (snapshot.error) throw new Error(snapshot.error);
      if (snapshot.nativeWindowShownAt && snapshot.persistenceReadyAt && snapshot.libraryReadyAt && snapshot.nativePlayerReadyAt && !snapshot.overlayPresent) break;
      await delay(25);
    }
    if (!snapshot?.nativeWindowShownAt || !snapshot?.nativePlayerReadyAt || snapshot.overlayPresent) throw new Error("Startup did not finish");
    const fromLaunch = (time) => Math.round(snapshot.timeOrigin + time - launchedAt);
    const result = {
      run,
      launchToNativeLoadingWindowMs: snapshot.nativeStartup?.firstVisibleUnixMs ? snapshot.nativeStartup.firstVisibleUnixMs - launchedAt : null,
      launchToFirstContentMs: fromLaunch(snapshot.paint.find(({ name }) => name === 'first-contentful-paint')?.startTime || snapshot.shellReadyAt),
      launchToShellMs: fromLaunch(snapshot.shellReadyAt),
      launchToWindowReadyMs: fromLaunch(snapshot.nativeWindowShownAt),
      launchToNativeEngineMs: fromLaunch(snapshot.nativePlayerReadyAt),
      snapshot
    };
    results.push(result);
    console.log(JSON.stringify(result));
  } finally {
    // Close only the exact child launched by this run. No process-name kills.
    if (player) {
      await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })`).catch(() => {});
      player.close();
    }
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null) child.kill();
  }
  await delay(300);
}
if (process.argv[4]) await writeFile(process.argv[4], JSON.stringify({ measuredAt: new Date().toISOString(), executable: resolve(executable), results }, null, 2) + "\n");

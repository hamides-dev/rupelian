import { connectPlayer } from "./cdp-connection.mjs";
import { basename, extname } from "node:path";

const videoPath = process.argv[2];
const droppedSubtitlePath = process.argv[3];
if (!videoPath || !droppedSubtitlePath) {
  throw new Error("Pass an absolute video path and an absolute subtitle path.");
}
const expectedSidecarName = `${basename(videoPath, extname(videoPath))}.srt`;
const droppedSubtitleName = basename(droppedSubtitlePath);

const player = await connectPlayer();
try {
  const result = await player.evaluate(`(async () => {
    const subtitles = window.__LINGO_SUBTITLE_TEST__;
    const native = window.__LINGO_NATIVE_TEST__;
    if (!subtitles || !native) throw new Error("player test APIs are unavailable");

    const expectedIdentity = ${JSON.stringify(`local:${videoPath.replace(/\\/g, "/").toLocaleLowerCase()}`)};
    const startupDeadline = performance.now() + 12000;
    while (performance.now() < startupDeadline) {
      const tracks = subtitles.snapshot().trackDetails;
      if (native.snapshot().playbackIdentity === expectedIdentity && tracks.some((track) => track.label === ${JSON.stringify(expectedSidecarName)})) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const startup = {
      identity: native.snapshot().playbackIdentity,
      subtitles: subtitles.snapshot()
    };

    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "tauri://drag-drop",
      payload: { paths: [${JSON.stringify(droppedSubtitlePath)}], position: { x: 400, y: 300 } }
    });
    const dropDeadline = performance.now() + 5000;
    while (performance.now() < dropDeadline) {
      const snapshot = subtitles.snapshot();
      const dropped = snapshot.trackDetails.find((track) => track.label === ${JSON.stringify(droppedSubtitleName)});
      if (dropped && snapshot.primary === dropped.id) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      expectedIdentity,
      startup,
      afterDrop: subtitles.snapshot()
    };
  })()`);

  const sidecar = result.startup.subtitles.trackDetails.find((track) => track.label === expectedSidecarName);
  const dropped = result.afterDrop.trackDetails.find((track) => track.label === droppedSubtitleName);
  if (result.startup.identity !== result.expectedIdentity) throw new Error("startup video argument was not opened");
  if (!sidecar || result.startup.subtitles.primary !== sidecar.id || !result.startup.subtitles.enabled) {
    throw new Error("matching sidecar subtitle was not loaded and activated");
  }
  if (!dropped || result.afterDrop.primary !== dropped.id || !result.afterDrop.enabled) {
    throw new Error("dropped subtitle was not added and activated");
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  player.close();
}

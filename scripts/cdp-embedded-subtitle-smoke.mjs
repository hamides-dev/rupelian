const debugPort = process.env.LINGO_CDP_PORT || "9223";
const videoPath = process.argv[2];
if (!videoPath) throw new Error("Pass an absolute softsub video path.");

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

const response = await send("Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(async () => {
    const api = window.__LINGO_SUBTITLE_TEST__;
    if (!api) throw new Error("subtitle test API unavailable");
    api.setVideoSource(${JSON.stringify(videoPath)});
    const deadline = Date.now() + 12000;
    let snapshot;
    while (Date.now() < deadline) {
      snapshot = api.snapshot();
      if (snapshot.embedded.length && snapshot.trackDetails.some((track) => track.source === "embedded" && track.cues > 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const embeddedTrack = snapshot.trackDetails.find((track) => track.source === "embedded");
    api.renderAt((embeddedTrack?.firstCueStart || 0) + 0.01);
    const groupTitles = [...document.querySelectorAll(".lp-subtitle-group > span")].map((item) => item.textContent.trim());
    return {
      catalog: snapshot.embedded,
      embeddedTrack,
      primary: snapshot.primary,
      enabled: snapshot.enabled,
      groupTitles,
      renderedText: document.querySelector(".lp-caption-primary")?.textContent || "",
      ccVisible: !document.querySelector("#cc-btn").classList.contains("lp-hidden")
    };
  })()`,
});

if (response.result?.exceptionDetails) {
  throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
}
const result = response.result.result.value;
const passed = result.catalog.length > 0
  && result.catalog.some((track) => track.textBased)
  && result.embeddedTrack?.cues > 0
  && result.primary?.startsWith("embedded:")
  && result.enabled
  && result.groupTitles.includes("Embedded subtitles")
  && result.renderedText === result.embeddedTrack.firstCueText
  && result.ccVisible;

console.log(JSON.stringify({ passed, ...result }, null, 2));
socket.close();
if (!passed) process.exitCode = 1;

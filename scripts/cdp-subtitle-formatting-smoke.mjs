import { resolve } from "node:path";

const port = process.env.LINGO_CDP_PORT || "9223";
const fixturePath = resolve("tests/fixtures/subtitle-styled.srt");
const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = pages.find((candidate) => candidate.url.includes("127.0.0.1:1420"));
if (!page) throw new Error("Rupelian WebView was not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveSocket, reject) => {
  socket.addEventListener("open", resolveSocket, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
const send = (method, params = {}) => new Promise((resolveCommand) => {
  const commandId = ++id;
  pending.set(commandId, resolveCommand);
  socket.send(JSON.stringify({ id: commandId, method, params }));
});

await send("Page.reload", { ignoreCache: true });
await new Promise((resolveWait) => setTimeout(resolveWait, 1400));
const response = await send("Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(async () => {
    const api = window.__LINGO_SUBTITLE_TEST__;
    if (!api) throw new Error("subtitle test API unavailable");
    api.setMediaContext("local");
    await api.loadLocalSubtitlePath(${JSON.stringify(fixturePath)}, true);
    api.renderAt(1);
    const overlay = document.querySelector(".lp-caption-overlay");
    const firstSpan = overlay.querySelector(".lp-caption-primary span");
    const first = {
      text: overlay.querySelector(".lp-caption-primary")?.textContent,
      top: overlay.classList.contains("lp-caption-v-top"),
      center: overlay.classList.contains("lp-caption-h-center"),
      color: getComputedStyle(firstSpan).color,
      weight: getComputedStyle(firstSpan).fontWeight
    };
    api.renderAt(4);
    const spans = [...overlay.querySelectorAll(".lp-caption-primary span")];
    const italic = spans.find((span) => span.textContent.includes("italic"));
    const blue = spans.find((span) => span.textContent.includes("blue"));
    return {
      first,
      secondText: overlay.querySelector(".lp-caption-primary")?.textContent,
      italic: getComputedStyle(italic).fontStyle,
      blueColor: getComputedStyle(blue).color,
      blueDecoration: getComputedStyle(blue).textDecorationLine
    };
  })()`
});
socket.close();
if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
const result = response.result.result.value;
console.log(JSON.stringify(result, null, 2));
if (result.first.text !== '"بخش پزشکی"' || result.first.text.includes("an8") || !result.first.top || !result.first.center) {
  throw new Error("ASS alignment overrides embedded in SRT were not interpreted");
}
if (result.first.color !== "rgb(255, 216, 77)" || Number(result.first.weight) < 700) {
  throw new Error("SRT font color or bold formatting was not rendered");
}
if (result.italic !== "italic" || result.blueColor !== "rgb(0, 0, 255)" || !result.blueDecoration.includes("underline")) {
  throw new Error("inline italic, ASS BGR color, or underline formatting was not rendered");
}

const debugPort = process.env.LINGO_CDP_PORT || "9223";
const pages = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
const page = pages.find(
  (candidate) => candidate.url.includes("127.0.0.1:1420") || candidate.url.startsWith("http://tauri.localhost"),
);

if (!page) throw new Error("The Rupelian WebView was not found.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let commandId = 0;
const pendingCommands = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const resolve = pendingCommands.get(message.id);
  if (resolve) {
    pendingCommands.delete(message.id);
    resolve(message);
  }
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++commandId;
    pendingCommands.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
  }
  return response.result.result.value;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const readWindowState = () => evaluate(`(async () => ({
  fullscreen: await window.__TAURI_INTERNALS__.invoke("plugin:window|is_fullscreen", { label: "main" }),
  maximized: await window.__TAURI_INTERNALS__.invoke("plugin:window|is_maximized", { label: "main" }),
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  screenWidth: window.screen.width,
  screenHeight: window.screen.height,
  screenX: window.screenX,
  screenY: window.screenY,
  bodyWidth: document.body.getBoundingClientRect().width,
  bodyHeight: document.body.getBoundingClientRect().height
}))()`);

const initial = await readWindowState();
if (initial.fullscreen) {
  await evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|set_fullscreen", { label: "main", value: false })`);
  await delay(500);
}

const beforeMaximize = await readWindowState();
if (!beforeMaximize.maximized) {
  await evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|toggle_maximize", { label: "main" })`);
  await delay(600);
}

await evaluate(`document.querySelector('[title="Fullscreen (F)"]').click()`);
await delay(800);
const inFullscreen = await readWindowState();

await evaluate(`document.querySelector('[title="Fullscreen (F)"]').click()`);
await delay(800);
const afterFullscreen = await readWindowState();

if (!beforeMaximize.maximized) {
  await evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|toggle_maximize", { label: "main" })`);
  await delay(500);
}

await evaluate(`document.querySelector("#native-video").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))`);
await delay(700);
const fullscreenByDoubleClick = await readWindowState();
await evaluate(`document.querySelector("#native-video").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))`);
await delay(700);
const restoredByDoubleClick = await readWindowState();

await evaluate(`window.__LINGO_NATIVE_TEST__.setYoutubeDragTestMode(true)`);
const beforeYoutubeSurfaceDrag = await readWindowState();
const beforeYoutubeDragRequestCount = await evaluate(`window.__LINGO_NATIVE_TEST__.getWindowDragRequestCount()`);
const dragX = Math.round(beforeYoutubeSurfaceDrag.innerWidth * .5);
const dragY = Math.round(beforeYoutubeSurfaceDrag.innerHeight * .42);
const youtubeDragHitTarget = await evaluate(`(() => {
  const element = document.elementFromPoint(${dragX}, ${dragY});
  return { id: element?.id || "", className: String(element?.className || ""), tauriDragRegion: element?.hasAttribute?.("data-tauri-drag-region") || false };
})()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragX, y: dragY });
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragX, y: dragY, button: "left", buttons: 1, clickCount: 1 });
await delay(120);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragX + 70, y: dragY + 42, button: "left", buttons: 1 });
await delay(250);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragX + 70, y: dragY + 42, button: "left", buttons: 0, clickCount: 1 });
await delay(500);
const afterYoutubeSurfaceDrag = await readWindowState();
const afterYoutubeDragRequestCount = await evaluate(`window.__LINGO_NATIVE_TEST__.getWindowDragRequestCount()`);
await evaluate(`window.__LINGO_NATIVE_TEST__.setYoutubeDragTestMode(false)`);

const currentViewport = await evaluate(`({ width: window.innerWidth, height: window.innerHeight })`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: currentViewport.width / 2, y: currentViewport.height / 2 });
// Chrome shares the sidebar's 460 ms transition; sample after it settles.
await delay(2600);
const hiddenChrome = await evaluate(`({
  hiddenClass: document.body.classList.contains("lp-chrome-hidden"),
  bodyClasses: document.body.className,
  topHovered: document.querySelector("#top-chrome").matches(":hover"),
  bottomHovered: document.querySelector("#bottom-chrome").matches(":hover"),
  topOpacity: getComputedStyle(document.querySelector("#top-chrome")).opacity,
  bottomOpacity: getComputedStyle(document.querySelector("#bottom-chrome")).opacity,
  videoShadeOpacities: [...document.querySelectorAll(".lp-video-shade")].map((shade) => getComputedStyle(shade).opacity)
})`);

await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: currentViewport.width / 2 + 2, y: currentViewport.height / 2 });
await delay(600);
const restoredChrome = await evaluate(`({
  visibleClass: document.body.classList.contains("lp-chrome-visible"),
  viewportHeight: window.innerHeight,
  topOpacity: getComputedStyle(document.querySelector("#top-chrome")).opacity,
  bottomOpacity: getComputedStyle(document.querySelector("#bottom-chrome")).opacity,
  videoShadeOpacities: [...document.querySelectorAll(".lp-video-shade")].map((shade) => getComputedStyle(shade).opacity),
  videoShadeBounds: [...document.querySelectorAll(".lp-video-shade")].map((shade) => {
    const bounds = shade.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, height: bounds.height };
  })
})`);

socket.close();

const result = {
  initial,
  initialSizeFitsScreen: initial.innerWidth <= initial.screenWidth && initial.innerHeight <= initial.screenHeight,
  inFullscreen,
  afterFullscreen,
  fullscreenFillsViewport:
    inFullscreen.fullscreen &&
    Math.abs(inFullscreen.innerWidth - inFullscreen.screenWidth) <= 1 &&
    Math.abs(inFullscreen.innerHeight - inFullscreen.screenHeight) <= 1 &&
    Math.abs(inFullscreen.bodyWidth - inFullscreen.innerWidth) <= 1 &&
    Math.abs(inFullscreen.bodyHeight - inFullscreen.innerHeight) <= 1,
  restoredMaximizedState: afterFullscreen.maximized,
  doubleClickTogglesFullscreen: fullscreenByDoubleClick.fullscreen && !restoredByDoubleClick.fullscreen,
  beforeYoutubeSurfaceDrag,
  afterYoutubeSurfaceDrag,
  youtubeDragHitTarget,
  youtubeSurfaceRequestedWindowDrag: afterYoutubeDragRequestCount === beforeYoutubeDragRequestCount + 1,
  youtubeSurfaceDragsWindow: Math.abs(afterYoutubeSurfaceDrag.screenX - beforeYoutubeSurfaceDrag.screenX) >= 20 || Math.abs(afterYoutubeSurfaceDrag.screenY - beforeYoutubeSurfaceDrag.screenY) >= 20,
  hiddenChrome,
  restoredChrome,
  chromeHiddenAfterTwoSeconds: hiddenChrome.hiddenClass && hiddenChrome.topOpacity === "0" && hiddenChrome.bottomOpacity === "0",
  chromeRestoredOnMovement: restoredChrome.visibleClass && restoredChrome.topOpacity === "1" && restoredChrome.bottomOpacity === "1",
  videoShadeTracksChrome:
    hiddenChrome.videoShadeOpacities.length === 2 &&
    hiddenChrome.videoShadeOpacities.every((opacity) => opacity === "0") &&
    restoredChrome.videoShadeOpacities.every((opacity) => opacity === "1"),
  videoShadeConfinedToChrome:
    restoredChrome.videoShadeBounds.length === 2 &&
    restoredChrome.videoShadeBounds[0].top === 0 &&
    restoredChrome.videoShadeBounds[0].bottom <= 164 &&
    restoredChrome.videoShadeBounds[1].top >= restoredChrome.viewportHeight - 170 &&
    restoredChrome.videoShadeBounds[1].bottom === restoredChrome.viewportHeight
};

console.log(JSON.stringify(result, null, 2));

if (!result.initialSizeFitsScreen || !result.fullscreenFillsViewport || !result.restoredMaximizedState || !result.doubleClickTogglesFullscreen || !result.youtubeSurfaceRequestedWindowDrag || !result.chromeHiddenAfterTwoSeconds || !result.chromeRestoredOnMovement || !result.videoShadeTracksChrome || !result.videoShadeConfinedToChrome) {
  process.exitCode = 1;
}

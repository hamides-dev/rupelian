const port = process.env.LINGO_CDP_PORT || "9223";
const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = pages.find((candidate) => candidate.url.includes("127.0.0.1:1420") || candidate.url.startsWith("http://tauri.localhost"));
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
const evaluate = async (expression) => {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
  return response.result.result.value;
};
const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

await send("Page.reload", { ignoreCache: true });
await delay(1200);
await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
await delay(250);
const compactResult = await evaluate(`(async () => {
  const titleRemoved = !document.querySelector("#media-title-container");
  const aiToolsButtons = [...document.querySelectorAll("#top-chrome button")].filter((button) => button.textContent.replace(/\\s+/g, " ").trim().includes("AI Tools"));
  const controlsAutoPauseRemoved = !document.querySelector('[title="Auto-pause after each sentence"]');
  const autoPauseSettingPreserved = Boolean(document.querySelector("#setting-auto-pause"));
  window.toggleSidebar();
  await new Promise((resolveWait) => setTimeout(resolveWait, 520));
  const sidebar = document.querySelector("#main-sidebar");
  const sidebarBounds = sidebar.getBoundingClientRect();
  const playerBounds = document.querySelector("#player-stage").getBoundingClientRect();
  const style = getComputedStyle(sidebar);
  const compactSidebarIsOffCanvas = innerWidth < 1024
    && Math.abs(sidebarBounds.top) < 2
    && Math.abs(sidebarBounds.right - innerWidth) < 2
    && Math.abs(sidebarBounds.bottom - innerHeight) < 2
    && parseFloat(style.borderTopRightRadius) === 0
    && sidebarBounds.width <= 421;
  const compactPlayerStaysFullWidth = Math.abs(playerBounds.right - innerWidth) < 2;
  window.closeSidebar();
  return {
    viewport: { width: innerWidth, height: innerHeight },
    titleRemoved,
    aiToolsButtonCount: aiToolsButtons.length,
    aiToolsTitle: aiToolsButtons[0]?.title || "",
    controlsAutoPauseRemoved,
    autoPauseSettingPreserved,
    compactSidebarIsOffCanvas,
    compactPlayerStaysFullWidth,
    sidebarBounds: { top: sidebarBounds.top, right: sidebarBounds.right, bottom: sidebarBounds.bottom, width: sidebarBounds.width }
  };
})()`);

await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
await delay(250);
const narrowDesktopResult = await evaluate(`(async () => {
  window.toggleSidebar();
  await new Promise((resolveWait) => setTimeout(resolveWait, 520));
  const sidebarBounds = document.querySelector("#main-sidebar").getBoundingClientRect();
  const playerBounds = document.querySelector("#player-stage").getBoundingClientRect();
  const topChromeBounds = document.querySelector("#top-chrome").getBoundingClientRect();
  const result = {
    viewport: { width: innerWidth, height: innerHeight },
    sidebarUsesOverlay: !document.body.classList.contains("lp-sidebar-push"),
    sidebarStaysAtRightEdge: Math.abs(sidebarBounds.right - innerWidth) < 2,
    playerStaysFullWidth: Math.abs(playerBounds.right - innerWidth) < 2,
    headerStaysFullWidth: Math.abs(topChromeBounds.right - innerWidth) < 2,
    playerWidth: playerBounds.width,
    sidebarWidth: sidebarBounds.width
  };
  window.closeSidebar();
  return result;
})()`);

await send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 720, deviceScaleFactor: 1, mobile: false });
await delay(250);
const wideDesktopResult = await evaluate(`(async () => {
  window.toggleSidebar();
  await new Promise((resolveWait) => setTimeout(resolveWait, 520));
  const sidebarBounds = document.querySelector("#main-sidebar").getBoundingClientRect();
  const playerBounds = document.querySelector("#player-stage").getBoundingClientRect();
  const result = {
    viewport: { width: innerWidth, height: innerHeight },
    sidebarReservesColumn: document.body.classList.contains("lp-sidebar-push"),
    playerMeetsMinimumWidth: playerBounds.width >= 800,
    playerMeetsSidebarEdge: Math.abs(playerBounds.right - sidebarBounds.left) < 2,
    playerWidth: playerBounds.width,
    sidebarWidth: sidebarBounds.width
  };
  window.closeSidebar();
  return result;
})()`);
await send("Emulation.clearDeviceMetricsOverride");
socket.close();

const result = { compact: compactResult, narrowDesktop: narrowDesktopResult, wideDesktop: wideDesktopResult };
console.log(JSON.stringify(result, null, 2));
if (!compactResult.titleRemoved || compactResult.aiToolsButtonCount !== 1 || compactResult.aiToolsTitle !== "Saved Library and AI Tutor" || !compactResult.controlsAutoPauseRemoved || !compactResult.autoPauseSettingPreserved || !compactResult.compactSidebarIsOffCanvas || !compactResult.compactPlayerStaysFullWidth || !narrowDesktopResult.sidebarUsesOverlay || !narrowDesktopResult.sidebarStaysAtRightEdge || !narrowDesktopResult.playerStaysFullWidth || !narrowDesktopResult.headerStaysFullWidth || !wideDesktopResult.sidebarReservesColumn || !wideDesktopResult.playerMeetsMinimumWidth || !wideDesktopResult.playerMeetsSidebarEdge) {
  process.exitCode = 1;
}

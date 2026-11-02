export async function connectPlayer() {
  const port = process.env.LINGO_CDP_PORT || "9223";
  const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  // Ignore a legacy splash target when diagnosing an older build.
  const page = pages.find((page) =>
    /127\.0\.0\.1:1420|tauri\.localhost|^tauri:/.test(page.url)
    && !/\/splashscreen\.html(?:[?#]|$)/.test(page.url)
  );
  if (!page) throw new Error("Rupelian WebView was not found");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("close", () => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error("Player disconnected")); }
    pending.clear();
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    for (const listener of listeners.get(message.method) || []) listener(message.params);
    if (message.method === "Runtime.consoleAPICalled") {
      const text = message.params.args?.map((arg) => arg.value).join(" ") || "";
      if (text.startsWith("[YT-NATIVE]")) console.error(text);
    }
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  });
  const send = (method, params = {}, timeout = 180000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, timeout) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.exception?.value || result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Runtime.enable");
  const reload = async () => {
    // Wait for the initial document bootstrap before asking WebView2 to reload.
    const initialStart = Date.now();
    while (!await evaluate('Boolean(window.__LINGO_YOUTUBE_TEST__ && window.__LINGO_NATIVE_TEST__)').catch(() => false)) {
      if (Date.now() - initialStart > 15000) throw new Error("Player did not initialize before reload");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await send("Page.reload", { ignoreCache: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const start = Date.now();
    while (!await evaluate('Boolean(window.__LINGO_YOUTUBE_TEST__ && window.__LINGO_NATIVE_TEST__)').catch(() => false)) {
      if (Date.now() - start > 15000) throw new Error("Player did not initialize after reload");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const on = (method, listener) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(listener);
    return () => listeners.get(method)?.delete(listener);
  };
  return { send, evaluate, reload, on, close: () => socket.close() };
}

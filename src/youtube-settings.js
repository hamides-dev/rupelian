import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export function initializeYoutubeSettings({ videoUrl, retryVideo, clearLegacySession }) {
  const $ = (selector) => document.querySelector(selector);
  const panel = $('[data-settings-panel="youtube"]');
  const status = $("#youtube-session-status");
  const linkInput = $("#youtube-sign-in-link");
  const copyLink = $("#youtube-sign-in-copy");
  const checkUrl = $("#youtube-session-url");
  let savedSession = null;
  let linkAttempt = null;
  let pollTimer = 0;
  let pollPending = false;
  let copyTimer = 0;
  let busy = false;
  let generation = 0;
  let returningToVideo = false;

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle("is-error", error);
  }

  function render() {
    panel.setAttribute("aria-busy", String(busy));
    panel.querySelectorAll("[data-session-action]").forEach(button => { button.disabled = busy; });
    $("#youtube-session-open").classList.toggle("hidden", Boolean(linkAttempt));
    $("#youtube-session-open").textContent = savedSession?.usable ? "Refresh access" : "Connect browser";
    $("#youtube-session-cancel").classList.toggle("hidden", !linkAttempt);
    $("#youtube-session-cancel").disabled = busy;
    $("#youtube-sign-in-link-area").classList.toggle("hidden", !linkAttempt);
    linkInput.value = linkAttempt?.url || "";
    copyLink.disabled = busy || !linkAttempt?.url;
    $("#youtube-sign-in-launch").disabled = busy || !linkAttempt?.url;
    $("#youtube-session-remove").classList.toggle("hidden", !savedSession?.saved);
    $("#youtube-session-check").disabled = busy || !savedSession?.usable || !checkUrl.value.trim();
    $("#youtube-session-retry").classList.toggle("hidden", !returningToVideo);
    $("#youtube-session-check-area").classList.toggle("hidden", !returningToVideo);
    $("#youtube-session-summary").textContent = linkAttempt ? "Waiting for your browser"
      : savedSession?.saved ? (savedSession.usable ? "Connected" : "Refresh needed") : "Not connected";
  }

  async function action(pending, task) {
    if (busy) return;
    busy = true;
    ++generation;
    message(pending);
    render();
    try { await task(); }
    catch (error) { message(String(error), true); }
    finally { busy = false; render(); schedulePoll(); }
  }

  async function acceptSession(session) {
    savedSession = session;
    linkAttempt = null;
    clearTimeout(pollTimer);
    await clearLegacySession();
    $("#youtube-session-fallback").open = false;
    message(returningToVideo ? "Connected. Retry your video below." : "Browser access saved on this device.");
  }

  async function adoptLink(next, expectedGeneration = generation) {
    if (!next) { linkAttempt = null; return; }
    if (next.status === "connected") {
      const session = await invoke("youtube_session_status");
      if (expectedGeneration !== generation) return;
      if (session.usable) await acceptSession(session);
      else { linkAttempt = null; message("Saved access needs refreshing. Connect your browser again.", true); }
    } else if (next.status === "ready") {
      linkAttempt = next;
    } else {
      linkAttempt = null;
      message(next.status === "expired" ? "The connection link expired. Prepare a new link when you are ready." : "Connection cancelled. Your browser and saved access were left unchanged.");
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (linkAttempt) pollTimer = window.setTimeout(poll, 700);
  }

  async function poll() {
    if (!linkAttempt || pollPending) return;
    if (busy) { schedulePoll(); return; }
    const current = generation;
    const id = linkAttempt.attemptId;
    pollPending = true;
    try {
      const next = await invoke("youtube_sign_in_link_status");
      if (current !== generation || linkAttempt?.attemptId !== id) return;
      await adoptLink(next);
    } catch { /* A transient polling failure must not discard a copied link. */ }
    finally { pollPending = false; render(); schedulePoll(); }
  }

  async function refresh() {
    if (busy) return;
    await action("Reading saved access…", async () => {
      const [session, pending] = await Promise.all([invoke("youtube_session_status"), invoke("youtube_sign_in_link_status")]);
      savedSession = session;
      message(pending?.status === "ready" ? "Open the link in your already signed-in browser and click Connect in that tab." : (session.usable ? "Browser access saved on this device." : session.saved ? "Access expired. Reconnect your browser." : "Public videos need no connection."), session.saved && !session.usable);
      await adoptLink(pending);
    });
  }

  $("#youtube-session-open").addEventListener("click", () => action("Preparing your browser connection link…", async () => {
    copyLink.textContent = "Copy";
    await adoptLink(await invoke("prepare_youtube_sign_in_link"));
    message("Paste the link into your signed-in browser and click Connect there.");
    linkInput.focus(); linkInput.select();
  }));
  $("#youtube-sign-in-launch").addEventListener("click", () => action("Opening the connection tab in your default browser…", async () => {
    if (linkAttempt) await invoke("open_youtube_sign_in_link", { attemptId: linkAttempt.attemptId });
    message("Click Connect in the browser tab. If YouTube is signed in in another browser, copy the link there instead.");
  }));
  $("#youtube-browser-extension").addEventListener("click", () => action("Opening the browser connector folder…", async () => {
    const path = await invoke("reveal_youtube_browser_extension");
    $("#youtube-browser-extension-path").textContent = path;
    message("In your signed-in browser, open chrome://extensions (Edge: edge://extensions), enable Developer mode, and use Load unpacked to select this folder. Then reload the connection tab. This setup is only needed once.");
  }));
  copyLink.addEventListener("click", async () => {
    if (busy || !linkAttempt?.url) return;
    const id = linkAttempt.attemptId;
    let copied = false;
    try { await navigator.clipboard.writeText(linkAttempt.url); copied = true; }
    catch { linkInput.focus(); linkInput.select(); try { copied = document.execCommand("copy"); } catch { /* Manual copy remains available. */ } }
    if (linkAttempt?.attemptId !== id) return;
    copyLink.textContent = copied ? "Copied" : "Copy";
    message(copied ? "Copied. Paste into the same browser profile where your YouTube account is signed in." : "Select the link and press Ctrl+C.", !copied);
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => { copyLink.textContent = "Copy"; }, 1800);
  });
  $("#youtube-session-cancel").addEventListener("click", () => action("Cancelling connection…", async () => {
    const cancelled = linkAttempt;
    linkAttempt = null;
    clearTimeout(pollTimer);
    if (cancelled) await invoke("cancel_youtube_sign_in_link", { attemptId: cancelled.attemptId });
    message("Connection cancelled. Your browser and previously saved access were left unchanged.");
  }));
  $("#youtube-session-import").addEventListener("click", () => action("Choose an exported cookies.txt file…", async () => {
    const path = await open({ multiple: false, title: "Import YouTube cookies", filters: [{ name: "Netscape cookies", extensions: ["txt"] }] });
    if (!path) { message(savedSession?.message || "Import cancelled. Saved access was left unchanged."); return; }
    // Finish the pending link first so it cannot overwrite a subsequent import.
    if (linkAttempt) await invoke("cancel_youtube_sign_in_link", { attemptId: linkAttempt.attemptId });
    await acceptSession(await invoke("import_youtube_cookies", { path }));
  }));
  $("#youtube-session-check").addEventListener("click", () => action("Checking video access…", async () => {
    message(await invoke("check_youtube_session", { url: checkUrl.value.trim() }));
  }));
  $("#youtube-session-remove").addEventListener("click", () => action("Removing saved access…", async () => {
    if (linkAttempt) await invoke("cancel_youtube_sign_in_link", { attemptId: linkAttempt.attemptId });
    linkAttempt = null;
    clearTimeout(pollTimer);
    savedSession = await invoke("remove_youtube_session");
    await clearLegacySession();
    message("Saved access removed. Your browser account stays signed in.");
  }));
  $("#youtube-session-retry").addEventListener("click", () => {
    if (busy) return;
    window.closeModal("settings-dialog"); window.openModal("youtube-modal");
    returningToVideo = false;
    retryVideo();
  });
  checkUrl.addEventListener("input", render);
  document.addEventListener("settings-tab-change", event => {
    if (event.detail !== "youtube") return;
    if (videoUrl()) checkUrl.value = videoUrl();
    refresh();
  });
  document.addEventListener("lingo-modal-close", event => {
    if (event.detail.id !== "settings-dialog" || !returningToVideo) return;
    returningToVideo = false;
    window.openModal("youtube-modal");
  });
  render();
  return { openFromError() { returningToVideo = true; window.closeModal("youtube-modal"); window.openSettingsTab("youtube"); } };
}

import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import "./style.css";
import "./toast.css";
import "./ai-settings.css";

const icon = (name, size = 18) => {
  const paths = {
    play: '<path d="m7 4 12 8-12 8V4Z" fill="currentColor"/>',
    pause: '<path d="M7 4h4v16H7zM15 4h4v16h-4z" fill="currentColor"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    volume: '<path d="M4 10v4h3l4 3V7l-4 3H4Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    settings: '<path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m19.4 15 .1-1.1 1.6-1.2-1.8-3.1-1.9.8-.9-.5-.2-2H12l-.2 2-.9.5-1.9-.8-1.8 3.1 1.6 1.2.1 1.1-1.6 1.2L9 19.3l1.9-.8.9.5.2 2h3.6l.2-2 .9-.5 1.9.8 1.8-3.1-1.6-1.2Z" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/>',
    expand: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    translate: '<path d="M4 5h11M9 3v2m1 0c0 6-3 10-7 12m3-7c1.5 2 3.5 3 5.5 3M14 19l3-8 3 8m-5-3h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    star: '<path d="m12 3 2.7 5.5 6 .9-4.4 4.3 1 6-5.3-2.8-5.3 2.8 1-6L3.3 9.4l6-.9L12 3Z" fill="currentColor"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
    chat: '<path d="M20 11.5a7.5 7.5 0 0 1-8 7.5c-1.2 0-2.4-.3-3.4-.8L4 20l1.4-3.7A7.4 7.4 0 1 1 20 11.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    backward: '<path d="M6 5v14M18 6l-8 6 8 6V6Z" fill="currentColor"/>',
    forward: '<path d="M18 5v14M6 6l8 6-8 6V6Z" fill="currentColor"/>',
    close: '<path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${paths[name]}</svg>`;
};

const app = document.querySelector("#app");
app.innerHTML = `
<main class="player-shell" id="shell">
  <div class="video-stage" id="video-stage">
    <div class="poster"></div><video id="video" playsinline></video>
    <div class="shade shade-top"></div><div class="shade shade-bottom"></div><div class="vignette"></div>
  </div>
  <header class="topbar" data-tauri-drag-region>
    <div class="brand" data-tauri-drag-region><button class="yt-logo" id="open-video" title="Open a local video">${icon("play", 15)}</button><b>RUPELIAN</b><span class="divider">•</span><button class="stream-pill" id="source-btn"><i></i> Local video</button></div>
    <div class="video-title" data-tauri-drag-region><span id="title">Cyberpunk: Edgerunners — S01E04</span><b>4K AV1</b></div>
    <div class="toolbar"><button class="quality">● <span>2160p 4K 60fps</span>⌄</button><button class="tool" id="subtitle-btn">${icon("translate", 16)} <span>Subtitles Studio</span></button><button class="tool" id="vocab-btn">${icon("star", 16)} <span>Saved to Library</span><strong id="saved-count">6</strong></button><button class="tool ai" id="tutor-btn">${icon("bolt", 16)} <span>AI Tutor</span></button><div class="window-controls"><button id="min-btn">—</button><button id="max-btn">□</button><button class="danger" id="close-btn">${icon("close", 15)}</button></div></div>
  </header>
  <section class="learning-zone">
    <div class="lesson-stack">
      <article class="word-card"><div class="word-head"><div><div class="word-row"><b lang="ja">約束</b><code>やくそく • yakusoku</code><span>JLPT N4</span></div><p>1. Promise; agreement; pledge; pact.<br>2. Rule; arrangement; convention.</p></div><button class="save-word" title="Save word">${icon("star", 17)}</button></div><footer><span>${icon("volume", 14)} Audio pronunciation</span><button id="ask-card">Ask AI Tutor</button><code>Freq Core 2K (#1,492)</code></footer></article>
      <article class="subtitle-card"><div class="target" id="caption-target" lang="ja"><ruby>今夜<rt>こんや</rt></ruby><span>の</span><ruby class="active">約束<rt>やくそく</rt></ruby><span>、</span><ruby>覚<rt>おぼ</rt></ruby><span>えているかい？</span></div><div class="roman" id="caption-roman">konya no yakusoku, oboete iru kai?</div><p id="caption-translation">“Do you remember the promise we made for tonight?”</p><div class="line-actions"><button id="repeat-btn">↻ Replay Line <kbd>R</kbd></button><button id="save-line">${icon("star", 12)} Save to Library <kbd>S</kbd></button><button id="translation-btn" class="accent">${icon("translate", 14)} AI Translation</button><button id="ask-line">${icon("chat", 14)} Ask Tutor</button></div></article>
    </div>
  </section>
  <aside class="sidebar hidden" id="sidebar"><div class="side-tabs"><div><button id="tab-vocab" class="selected">${icon("star", 15)} Saved to Library</button><button id="tab-ai">${icon("bolt", 15)} AI Tutor</button></div><button id="side-close">${icon("close")}</button></div>
    <section id="vocab-view" class="side-content"><div class="side-title"><div><h2>Saved Vocabulary <b>6 Cards</b></h2><p>Words & phrases saved from this video</p></div><button class="round-add">+</button></div><div class="filters"><button class="selected">All</button><button>New</button><button>Learning</button><button>Learned</button></div><div class="vocab-list"><article><header><b>pennies</b><code>1×</code><span>Saved Card</span></header><p>Small monetary units; a very small amount of money.</p><div><code>“I haven't got two pennies to rub together.”</code><button>▶| Jump</button></div><blockquote dir="rtl">پول خرد؛ مقدار بسیار کمی پول</blockquote></article><article><header><b>look</b><code class="green">4×</code><span class="learned">Learned</span></header><p>To direct your eyes in order to see something.</p><div><code>“Look at the city lights.”</code><button>▶| Jump</button></div></article></div></section>
    <section id="ai-view" class="side-content hidden"><div class="ai-banner"><span>${icon("bolt", 20)}</span><div><b>AI Co-Pilot</b><small>Watching the active subtitle</small></div></div><div class="messages"><div class="bot">Currently analyzing caption at <b>08:42</b>:<br><strong lang="ja">今夜の約束、覚えているかい？</strong></div><div class="human">Why is 約束 highlighted?</div><div class="bot">It means <b>promise</b>. Here it carries emotional weight: the speaker is reminding someone of a meaningful commitment.</div></div><form id="chat-form"><input id="chat-input" placeholder="Ask about Japanese grammar or slang…"><button>${icon("chat", 17)}</button></form></section>
  </aside>
  <footer class="control-dock"><div class="timeline-wrap"><input id="timeline" type="range" min="0" max="100" value="41"><div class="time"><b id="current-time">08:42</b><span>/ <span id="duration">21:34</span></span><label>Scene 03: Rainy City</label></div></div><div class="controls"><div class="left-controls"><button id="open-video-2" title="Open video">${icon("folder", 19)}</button><button id="back-btn">${icon("backward", 19)}</button><button class="play" id="play-btn">${icon("pause", 20)}</button><button id="forward-btn">${icon("forward", 19)}</button><button id="volume-btn">${icon("volume", 19)}</button><input id="volume" type="range" min="0" max="1" step=".01" value=".8"></div><div class="right-controls"><button id="autopause">↻ Auto-pause</button><button id="speed">1.0×</button><button class="cc" id="cc-btn">CC</button><button id="fullscreen">${icon("expand", 18)}</button><button id="settings">${icon("settings", 18)}</button></div></div>
  </footer>
  <div class="dialog hidden" id="dialog"><div class="dialog-card"><header><div class="cc-square">CC</div><div><h2>Subtitles & AI Studio</h2><p>Load captions and prepare their AI translation.</p></div><button id="dialog-close">${icon("close")}</button></header><div class="dialog-body"><label>CAPTION SOURCE <b id="caption-status">DEMO SUBTITLES</b></label><input id="subtitle-source" value="Cyberpunk_Edgerunners_S01E04_Official_JA.srt" readonly><div class="dialog-buttons"><button id="choose-subtitle">Choose subtitle file</button><button id="clear-subtitles">Use demo subtitles</button></div><hr><h3>AI TRANSLATION STREAM</h3><div class="translation-preview"><span id="dialog-cue" lang="ja">今夜の約束、覚えているかい？</span><b id="dialog-translation">“Do you remember the promise we made for tonight?”</b><small>Translation is cached locally and only sent when you request it.</small></div></div></div></div>
  <div class="dialog hidden" id="settings-dialog"><div class="dialog-card settings-card"><header><div class="cc-square">AI</div><div><h2>AI Provider Settings</h2><p>OpenAI-compatible endpoint. Your key is only held for this session.</p></div><button id="settings-close">${icon("close")}</button></header><form class="dialog-body ai-settings" id="settings-form"><label>API BASE URL</label><input id="provider-url" required type="url" placeholder="https://api.openai.com/v1"><label>MODEL</label><input id="provider-model" required placeholder="gpt-4.1-mini"><label>API KEY <small>not saved to disk</small></label><input id="provider-key" required type="password" autocomplete="off" placeholder="sk-…"><p class="provider-note">For local OpenAI-compatible servers, use <code>http://localhost:PORT/v1</code>. Requests are sent only after you press AI Translation.</p><button class="save-provider" type="submit">Save session configuration</button></form></div></div>
  <input class="hidden" id="subtitle-file-input" type="file" accept=".srt,.vtt,text/vtt,text/plain">
  <div class="drop-hint hidden" id="drop-hint">Drop a video file to begin</div>
  <div class="toast hidden" id="toast" role="status"></div>
</main>`;

const $ = (selector) => document.querySelector(selector);
const video = $("#video");
const shell = $("#shell");
let autoplayAfterLoad = false;
let subtitleCues = [];
let activeCue = null;
let savedLines = JSON.parse(localStorage.getItem("lingo-cinema.saved-lines") || "[]");
let currentVideoPath = "";
let translationRequested = false;
let aiPreferences = { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" };
try { aiPreferences = { ...aiPreferences, ...JSON.parse(localStorage.getItem("lingo-cinema.ai-preferences") || "{}") }; } catch { /* Ignore corrupt local preferences. */ }
$("#provider-url").value = aiPreferences.baseUrl;
$("#provider-model").value = aiPreferences.model;

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
function setPlaying(playing) { $("#play-btn").innerHTML = icon(playing ? "pause" : "play", 20); }
function showToast(message) { const toast = $("#toast"); toast.textContent = message; toast.classList.remove("hidden"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.add("hidden"), 2800); }
function normalizeCueText(value) { return value.replace(/<[^>]*>|{\\[^}]*}/g, "").replace(/\\[Nn]/g, "\n").replace(/\s+/g, " ").trim(); }
function timestampToSeconds(value) { const parts = value.trim().replace(",", ".").split(":").map(Number); return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]; }
function parseSubtitleText(raw) { const blocks = raw.replace(/^\uFEFF/, "").replace(/\r/g, "").trim().split(/\n{2,}/); const cues = []; for (const block of blocks) { const lines = block.split("\n"); const timeIndex = lines.findIndex((line) => line.includes("-->")); if (timeIndex < 0) continue; const [startRaw, endRaw] = lines[timeIndex].split("-->"); const text = normalizeCueText(lines.slice(timeIndex + 1).join(" ")); const start = timestampToSeconds(startRaw); const end = timestampToSeconds(endRaw.trim().split(/\s+/)[0]); if (text && Number.isFinite(start) && Number.isFinite(end) && end >= start) cues.push({ start, end, text }); } if (!cues.length) throw new Error("No valid subtitle cues were found in this file."); return cues.sort((a, b) => a.start - b.start); }
function applySubtitleCues(cues, source) { subtitleCues = cues; activeCue = null; $("#subtitle-source").value = source; $("#caption-status").textContent = `${cues.length} CUES LOADED`; $("#dialog-cue").textContent = cues[0].text; $("#caption-translation").textContent = "Translation is ready to request from your AI provider."; showToast(`${cues.length} subtitle cues loaded`); syncSubtitle(); }
function syncSubtitle() { if (!subtitleCues.length) return; const cue = subtitleCues.find((item) => video.currentTime >= item.start && video.currentTime <= item.end); if (!cue || cue === activeCue) return; activeCue = cue; $("#caption-target").textContent = cue.text; $("#caption-target").lang = ""; $("#caption-roman").textContent = `${formatTime(cue.start)} — ${formatTime(cue.end)}`; $("#caption-translation").textContent = "Choose AI Translation to explain this line in context."; $("#dialog-cue").textContent = cue.text; $("#dialog-translation").textContent = "Awaiting AI translation"; }
function updateSavedCount() { $("#saved-count").textContent = String(savedLines.length); }
function renderSavedLines() { document.querySelectorAll("[data-saved-line]").forEach((card) => card.remove()); const list = document.querySelector(".vocab-list"); savedLines.slice(0, 12).reverse().forEach((item) => { const card = document.createElement("article"); card.dataset.savedLine = "true"; const header = document.createElement("header"); const name = document.createElement("b"); name.textContent = item.text.length > 35 ? `${item.text.slice(0, 35)}…` : item.text; const count = document.createElement("code"); count.textContent = "Line"; const badge = document.createElement("span"); badge.textContent = "Saved"; header.append(name, count, badge); const description = document.createElement("p"); description.textContent = item.text; const actions = document.createElement("div"); const timestamp = document.createElement("code"); const start = item.subtitleStart ?? item.start ?? 0; const end = item.subtitleEnd ?? item.end ?? start; timestamp.textContent = `${formatTime(start)} — ${formatTime(end)}`; const jump = document.createElement("button"); jump.textContent = "▶| Jump"; jump.addEventListener("click", () => { video.currentTime = start; video.play().catch(() => {}); }); actions.append(timestamp, jump); card.append(header, description, actions); list.prepend(card); }); }
async function hydrateLibrary() { try { savedLines = await invoke("list_phrases"); } catch { /* Browser preview retains its local demo library. */ } updateSavedCount(); renderSavedLines(); }
async function saveCurrentLine() { const cue = activeCue || { start: video.currentTime, end: video.currentTime, text: $("#caption-target").textContent }; if (!cue.text) return; try { const saved = await invoke("save_phrase", { input: { text: cue.text, translation: $("#caption-translation").textContent, videoPath: currentVideoPath, subtitleStart: cue.start, subtitleEnd: cue.end } }); const index = savedLines.findIndex((item) => item.id === saved.id); if (index >= 0) savedLines[index] = saved; else savedLines.unshift(saved); showToast("Line saved to your local library"); } catch { if (savedLines.some((item) => item.text === cue.text && item.start === cue.start)) return showToast("This line is already in your library"); savedLines.unshift({ ...cue, savedAt: Date.now() }); localStorage.setItem("lingo-cinema.saved-lines", JSON.stringify(savedLines)); showToast("Line saved in browser preview"); } updateSavedCount(); renderSavedLines(); }
async function chooseSubtitles() { try { const path = await open({ multiple: false, filters: [{ name: "Subtitles", extensions: ["srt", "vtt"] }] }); if (!path) return; const cues = await invoke("load_subtitles", { path }); applySubtitleCues(cues, String(path).split(/[\\/]/).pop()); } catch { $("#subtitle-file-input").click(); showToast("Use the file chooser to load a local SRT or VTT file"); } }
function openSettings() { $("#settings-dialog").classList.remove("hidden"); $("#provider-key").focus(); }
async function translateCurrentCue() { const apiKey = $("#provider-key").value.trim(); if (!apiKey) { translationRequested = true; openSettings(); showToast("Add an API key to translate the active line"); return; } const text = activeCue?.text || $("#caption-target").textContent.trim(); if (!text) return showToast("There is no active subtitle to translate"); const button = $("#translation-btn"); button.disabled = true; button.textContent = "Translating…"; try { const explanation = await invoke("explain_subtitle", { request: { baseUrl: $("#provider-url").value.trim(), apiKey, model: $("#provider-model").value.trim(), text } }); $("#caption-translation").textContent = explanation; $("#dialog-translation").textContent = explanation; showToast("AI explanation received"); } catch (error) { showToast(typeof error === "string" ? error : "The AI request could not be completed"); } finally { button.disabled = false; button.innerHTML = `${icon("translate", 14)} AI Translation`; } }
function loadVideo(file) {
  if (!file) return;
  const name = file.name || String(file).split(/[\\/]/).pop();
  currentVideoPath = file instanceof File ? name : String(file);
  $("#title").textContent = name.replace(/\.[^.]+$/, "");
  if (file instanceof File) video.src = URL.createObjectURL(file);
  else video.src = convertFileSrc(String(file));
  autoplayAfterLoad = true;
  video.load();
  showToast(`Loading ${name}…`);
}
async function chooseVideo() {
  try { const path = await open({ multiple: false, filters: [{ name: "Video", extensions: ["mp4", "mkv", "webm", "mov", "avi", "m4v"] }] }); if (path) loadVideo(path); } catch { $("#drop-hint").textContent = "File picker is available in the desktop app"; $("#drop-hint").classList.remove("hidden"); setTimeout(() => $("#drop-hint").classList.add("hidden"), 2200); }
}
function openSidebar(tab) { $("#sidebar").classList.remove("hidden"); switchTab(tab); }
function switchTab(tab) { const vocab = tab === "vocab"; $("#vocab-view").classList.toggle("hidden", !vocab); $("#ai-view").classList.toggle("hidden", vocab); $("#tab-vocab").classList.toggle("selected", vocab); $("#tab-ai").classList.toggle("selected", !vocab); }

["#open-video", "#open-video-2", "#source-btn"].forEach((id) => $(id).addEventListener("click", chooseVideo));
$("#play-btn").addEventListener("click", () => video.paused ? video.play() : video.pause());
video.addEventListener("play", () => setPlaying(true)); video.addEventListener("pause", () => setPlaying(false));
video.addEventListener("loadedmetadata", () => { $("#timeline").max = Math.floor(video.duration); $("#duration").textContent = formatTime(video.duration); showToast("Video loaded"); if (autoplayAfterLoad) video.play().catch(() => showToast("Press Play to start the video")); });
video.addEventListener("error", () => { const errors = { 1: "Video loading was cancelled", 2: "The video file could not be read", 3: "This video could not be decoded", 4: "This video format or codec is not supported" }; showToast(errors[video.error?.code] || "The video could not be opened"); setPlaying(false); });
video.addEventListener("timeupdate", () => { $("#timeline").value = video.currentTime; $("#current-time").textContent = formatTime(video.currentTime); syncSubtitle(); });
$("#timeline").addEventListener("input", (e) => { video.currentTime = e.target.value; });
$("#volume").addEventListener("input", (e) => { video.volume = e.target.value; video.muted = false; });
$("#volume-btn").addEventListener("click", () => { video.muted = !video.muted; });
$("#back-btn").addEventListener("click", () => video.currentTime = Math.max(0, video.currentTime - 5)); $("#forward-btn").addEventListener("click", () => video.currentTime = Math.min(video.duration || 0, video.currentTime + 5));
$("#repeat-btn").addEventListener("click", () => { video.currentTime = Math.max(0, video.currentTime - 5); video.play(); });
$("#vocab-btn").addEventListener("click", () => openSidebar("vocab")); $("#tutor-btn").addEventListener("click", () => openSidebar("ai")); $("#ask-card").addEventListener("click", () => openSidebar("ai")); $("#ask-line").addEventListener("click", () => openSidebar("ai"));
$("#side-close").addEventListener("click", () => $("#sidebar").classList.add("hidden")); $("#tab-vocab").addEventListener("click", () => switchTab("vocab")); $("#tab-ai").addEventListener("click", () => switchTab("ai"));
["#subtitle-btn", "#cc-btn"].forEach((id) => $(id).addEventListener("click", () => $("#dialog").classList.remove("hidden"))); $("#dialog-close").addEventListener("click", () => $("#dialog").classList.add("hidden"));
$("#translation-btn").addEventListener("click", translateCurrentCue); $("#settings").addEventListener("click", openSettings); $("#settings-close").addEventListener("click", () => $("#settings-dialog").classList.add("hidden"));
$("#settings-form").addEventListener("submit", (event) => { event.preventDefault(); aiPreferences = { baseUrl: $("#provider-url").value.trim(), model: $("#provider-model").value.trim() }; localStorage.setItem("lingo-cinema.ai-preferences", JSON.stringify(aiPreferences)); $("#settings-dialog").classList.add("hidden"); showToast("Provider settings saved; the key will not be stored"); if (translationRequested) { translationRequested = false; translateCurrentCue(); } });
$("#choose-subtitle").addEventListener("click", chooseSubtitles);
$("#subtitle-file-input").addEventListener("change", async (event) => { const file = event.target.files[0]; if (!file) return; try { applySubtitleCues(parseSubtitleText(await file.text()), file.name); } catch (error) { showToast(error.message); } });
$("#clear-subtitles").addEventListener("click", () => { subtitleCues = []; activeCue = null; $("#caption-status").textContent = "DEMO SUBTITLES"; $("#subtitle-source").value = "Cyberpunk_Edgerunners_S01E04_Official_JA.srt"; showToast("Demo subtitles restored"); });
$("#save-line").addEventListener("click", saveCurrentLine); hydrateLibrary();
$("#fullscreen").addEventListener("click", () => document.fullscreenElement ? document.exitFullscreen() : shell.requestFullscreen());
$("#speed").addEventListener("click", (e) => { const rates = [1, 1.25, 1.5, .75]; const next = rates[(rates.indexOf(video.playbackRate) + 1) % rates.length]; video.playbackRate = next; e.currentTarget.textContent = `${next.toFixed(2).replace(".00", "")}×`; });
$("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); const input = $("#chat-input"); if (!input.value.trim()) return; const text = input.value; input.value = ""; document.querySelector(".messages").insertAdjacentHTML("beforeend", `<div class="human">${text.replace(/[<>&]/g, "")}</div><div class="bot">I’m ready to help. Connect your preferred AI provider in Settings to receive a full answer.</div>`); });
window.addEventListener("dragover", (e) => { e.preventDefault(); $("#drop-hint").classList.remove("hidden"); }); window.addEventListener("dragleave", () => $("#drop-hint").classList.add("hidden")); window.addEventListener("drop", (e) => { e.preventDefault(); $("#drop-hint").classList.add("hidden"); loadVideo(e.dataTransfer.files[0]); });
document.addEventListener("keydown", (e) => { if (e.target.matches("input")) return; if (e.code === "Space") { e.preventDefault(); video.paused ? video.play() : video.pause(); } if (e.key.toLowerCase() === "r") $("#repeat-btn").click(); if (e.key.toLowerCase() === "s") $("#save-line").click(); if (e.key === "Escape") { $("#dialog").classList.add("hidden"); $("#settings-dialog").classList.add("hidden"); $("#sidebar").classList.add("hidden"); } });
if (window.__TAURI_INTERNALS__) {
  const appWindow = getCurrentWindow();
  const runWindowAction = async (action) => { try { await action(); } catch (error) { showToast(`Window action failed: ${error}`); } };
  $("#min-btn").onclick = () => runWindowAction(() => appWindow.minimize());
  $("#max-btn").onclick = () => runWindowAction(() => appWindow.toggleMaximize());
  $("#close-btn").onclick = () => runWindowAction(() => appWindow.close());
  $(".topbar").addEventListener("mousedown", (event) => { if (event.button === 0 && !event.target.closest("button, input, select")) runWindowAction(() => appWindow.startDragging()); });
  $(".topbar").addEventListener("dblclick", (event) => { if (!event.target.closest("button, input, select")) runWindowAction(() => appWindow.toggleMaximize()); });
}

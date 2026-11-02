// End-to-end Chrome extension test. A temporary headless browser contains only
// synthetic YouTube cookies; the user's everyday browser is never automated.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { connectPlayer } from './cdp-connection.mjs';

assert(process.env.LINGO_EXPECTED_DATA_DIR, 'Set LINGO_EXPECTED_DATA_DIR to isolated app data');
const profile = await mkdtemp(join(tmpdir(), 'lingo-connector-chrome-test-'));
const chrome = spawn(process.env.LINGO_CHROME_EXE || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let sequence = 0, buffer = '', attempt;
const pending = new Map();
const handlers = new Map();
const on = (method, handler) => handlers.set(method, handler);
chrome.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  while (buffer.includes('\0')) {
    const end = buffer.indexOf('\0');
    const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!raw) continue;
    const message = JSON.parse(raw), item = pending.get(message.id);
    if (message.method) handlers.get(message.method)?.(message.params, message.sessionId);
    if (!item) continue;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
  pending.set(id, { resolve: resolveCall, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (condition, label) => {
  const deadline = Date.now() + 50000;
  while (!await condition()) { if (Date.now() > deadline) throw new Error(label); await sleep(150); }
};
let player = await connectPlayer();
const invoke = (command, args = {}) => player.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
try {
  await player.reload();
  await wait(() => player.evaluate('document.body.dataset.persistenceReady === "true"'), 'Persistence did not hydrate');
  const paths = await player.evaluate('window.__LINGO_SUBTITLE_TEST__.persistentDataPaths()');
  assert.equal(resolve(paths.rootPath), resolve(process.env.LINGO_EXPECTED_DATA_DIR));
  await invoke('remove_youtube_session');
  attempt = await invoke('prepare_youtube_sign_in_link');
  await send('Browser.getVersion');
  const extension = await send('Extensions.loadUnpacked', { path: resolve('src-tauri/browser-extension') });
  assert(extension.id, 'Chrome must load the real extension');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const tab = (method, params = {}) => send(method, params, sessionId);
  await tab('Page.enable');
  await tab('DOM.enable');
  await tab('Network.enable');
  await tab('Network.setCookie', { name: 'SAPISID', value: 'synthetic-extension-cookie-only', domain: '.youtube.com', path: '/', secure: true, httpOnly: true });
  const before = (await send('Target.getTargets')).targetInfos.filter(item => item.type === 'page').length;
  await tab('Page.navigate', { url: attempt.url });
  const findButton = node => {
    if (node.nodeName === 'BUTTON') return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const match = findButton(child); if (match) return match; }
  };
  let button;
  await wait(async () => { button = findButton((await tab('DOM.getDocument', { depth: -1, pierce: true })).root); return button; }, 'Real content script did not create Connect');
  assert(!(await invoke('youtube_session_status')).saved, 'No cookies may be shared before the click');
  assert.equal((await invoke('youtube_sign_in_link_status')).status, 'ready');
  const { model } = await tab('DOM.getBoxModel', { nodeId: button.nodeId });
  const x = (model.content[0] + model.content[4]) / 2, y = (model.content[1] + model.content[5]) / 2;
  await tab('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await tab('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await wait(async () => (await invoke('youtube_sign_in_link_status')).status === 'connected', 'Actual extension did not connect');
  assert((await invoke('youtube_session_status')).usable);
  const targets = (await send('Target.getTargets')).targetInfos;
  assert.equal(targets.filter(item => item.type === 'page').length, before, 'Connecting must not create another tab or window');
  assert.equal(targets.find(item => item.targetId === targetId).url, attempt.url, 'The original connection tab stays open');
  const cookies = await tab('Network.getCookies', { urls: ['https://www.youtube.com/'] });
  assert(cookies.cookies.some(c => c.name === 'SAPISID' && c.value === 'synthetic-extension-cookie-only'), 'Browser account remains signed in');
  const text = await tab('Runtime.evaluate', { expression: 'document.body.textContent', returnByValue: true });
  assert(!text.result.value.includes('synthetic-extension-cookie-only'), 'Cookie values never enter page DOM');
  console.log('PASS: real Chrome connector, trusted click, direct cookie transfer, same tab/profile and retained browser cookies.');
} finally {
  if (attempt) await invoke('cancel_youtube_sign_in_link', { attemptId: attempt.attemptId }).catch(() => {});
  await invoke('remove_youtube_session').catch(() => {});
  player.close();
  await send('Browser.close').catch(() => {});
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear();
  await sleep(1000);
  assert.equal(resolve(profile, '..'), resolve(tmpdir()), 'Cleanup must stay in the OS temporary directory');
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}

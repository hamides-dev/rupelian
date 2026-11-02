// Real Rust loopback/DPAPI regression using synthetic cookies and isolated data only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { connectPlayer } from './cdp-connection.mjs';

const expectedRoot = process.env.LINGO_EXPECTED_DATA_DIR;
assert(expectedRoot, 'Set LINGO_EXPECTED_DATA_DIR to the isolated test app data directory');
const player = await connectPlayer();
const invoke = (command, args = {}) => player.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const fixture = '# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tlingo-synthetic-bridge-secret\n';
let attempt;
try {
  await player.reload();
  const paths = await player.evaluate('window.__LINGO_SUBTITLE_TEST__.persistentDataPaths()');
  assert.equal(resolve(paths.rootPath), resolve(expectedRoot), 'Never mutate real Documents data');
  await invoke('remove_youtube_session');
  for (const command of ['youtube_browser_action_status', 'youtube_account_status', 'set_youtube_video_rating', 'add_youtube_video_to_playlist']) {
    await assert.rejects(invoke(command), /not found|unknown|not allowed/i, 'Removed social commands must not be callable');
  }
  attempt = await invoke('prepare_youtube_sign_in_link');
  for (const ua of ['Chrome/155.0.0.0', 'Chrome/155.0.0.0 Edg/155.0.0.0', 'Firefox/145.0']) {
    const page = await fetch(attempt.url, { headers: { 'User-Agent': ua } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert(html.includes('name="lingo-browser-connector" content="1"'));
    assert(html.includes('Open YouTube in a new tab'));
    assert(!html.includes('accounts.google.com'));
    assert.equal((await invoke('youtube_sign_in_link_status')).status, 'ready', 'Navigation must never launch another browser or start a managed session');
  }
  for (const badOrigin of ['https://attacker.invalid', 'http://127.0.0.1:9876', 'null']) {
    assert.equal((await fetch(attempt.url, { method: 'POST', headers: { Origin: badOrigin }, body: fixture })).status, 403);
  }
  assert.equal((await fetch(attempt.url, { method: 'POST', headers: { Origin: origin }, body: 'not cookies' })).status, 409);
  assert.equal((await fetch(attempt.url, { method: 'POST', headers: { Origin: origin }, body: 'x'.repeat(2 * 1024 * 1024 + 1) })).status, 413);
  assert(!(await invoke('youtube_session_status')).saved);
  const saved = await fetch(attempt.url, { method: 'POST', headers: { Origin: origin }, body: fixture });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true }, 'Playback connection returns no rating-channel registration');
  assert.equal((await invoke('youtube_sign_in_link_status')).status, 'connected');
  const status = await invoke('youtube_session_status');
  assert(status.usable && status.saved);
  assert(!JSON.stringify(status).includes('lingo-synthetic-bridge-secret'));
  const disk = await readFile(join(expectedRoot, 'youtube-session.json'), 'utf8');
  assert(!disk.includes('lingo-synthetic-bridge-secret'), 'DPAPI must protect access at rest');
  assert.equal((await fetch(attempt.url, { method: 'POST', headers: { Origin: origin }, body: fixture })).status, 409, 'Used link cannot save again');
  const completed = await fetch(attempt.url).then(r => r.text());
  assert(completed.includes('Connected'));
  attempt = await invoke('prepare_youtube_sign_in_link');
  const cancelledUrl = attempt.url;
  await invoke('cancel_youtube_sign_in_link', { attemptId: attempt.attemptId });
  attempt = null;
  const late = await fetch(cancelledUrl, { method: 'POST', headers: { Origin: origin }, body: fixture }).catch(() => null);
  assert(!late || !late.ok, 'Cancellation blocks late writes');
  assert((await invoke('youtube_session_status')).usable, 'Cancellation preserves saved access');
  await invoke('remove_youtube_session');
  console.log('PASS: same-tab page for every browser, extension-only submission, bounds, DPAPI, replay rejection and cancellation. Synthetic cookies only.');
} finally {
  if (attempt) await invoke('cancel_youtube_sign_in_link', { attemptId: attempt.attemptId }).catch(() => {});
  await invoke('remove_youtube_session').catch(() => {});
  player.close();
}

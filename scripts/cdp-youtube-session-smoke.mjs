// Deterministic current-profile connection UI; never reads or changes a Google account.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectPlayer } from './cdp-connection.mjs';
const player = await connectPlayer();
try {
  player.on('Fetch.requestPaused', async ({ requestId }) => {
    try {
      const response = await player.send('Fetch.getResponseBody', { requestId });
      const source = response.base64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body;
      const body = source.replaceAll('window.__TAURI_INTERNALS__.invoke(cmd, args, options)', '(window.__LINGO_MOCK_INVOKE__ || window.__TAURI_INTERNALS__.invoke)(cmd, args, options)');
      await player.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], body: Buffer.from(body).toString('base64') });
    } catch { await player.send('Fetch.continueRequest', { requestId }).catch(() => {}); }
  });
  await player.send('Fetch.enable', { patterns: [{ urlPattern: '*/node_modules/.vite/deps/*.js*', requestStage: 'Response' }] });
  await player.reload();
  const result = await player.evaluate(`(${async function () {
    const $ = selector => document.querySelector(selector);
    const assert = (ok, label) => { if (!ok) throw new Error(label); };
    const calls = [];
    const wait = async condition => {
      const start = Date.now();
      while (!condition()) { if (Date.now() - start > 8000) throw new Error('Timed out: ' + $('#youtube-session-status').textContent); await new Promise(r => setTimeout(r, 30)); }
    };
    const idle = () => wait(() => $('[data-settings-panel="youtube"]').getAttribute('aria-busy') === 'false');
    const original = window.__TAURI_INTERNALS__.invoke;
    let saved = false, pending = null, releasePoll = null, delayPoll = false, checkFails = true, importCancelled = true, sequence = 0;
    const url = 'https://www.youtube.com/watch?v=session-test';
    const session = () => ({ saved, usable: saved, source: saved ? 'Personal browser connector' : '', message: saved ? 'Saved access restored.' : 'No saved access.' });
    const media = { videoId: 'session-test', title: 'Session retry test', channel: 'Test', webpageUrl: url, duration: 60, thumbnail: '', formats: [{ id: 'test', label: '360p', details: 'Test format', height: 360 }], audioTracks: [], subtitles: [] };
    window.__LINGO_MOCK_INVOKE__ = async (command, args = {}, ...rest) => {
      calls.push({ command, args });
      if (command === 'youtube_session_status') return session();
      if (command === 'youtube_sign_in_link_status') {
        if (delayPoll) return new Promise(resolve => { releasePoll = resolve; });
        return pending;
      }
      if (command === 'prepare_youtube_sign_in_link') return (pending = { attemptId: 'test-' + ++sequence, url: 'http://127.0.0.1:9875/connect/' + 'a'.repeat(43), status: 'ready' });
      if (command === 'open_youtube_sign_in_link') return pending;
      if (command === 'cancel_youtube_sign_in_link') { pending = null; return; }
      if (command === 'resolve_youtube') { if (!saved) throw 'Sign in to confirm you are not a bot'; return media; }
      if (command === 'check_youtube_session') { if (checkFails) throw 'Session expired. Connect again.'; return 'This video is accessible using saved access.'; }
      if (command === 'remove_youtube_session') { saved = false; return session(); }
      if (command === 'plugin:dialog|open') return importCancelled ? null : 'C:/test/cookies.txt';
      if (command === 'import_youtube_cookies') { saved = true; return session(); }
      if (command === 'save_user_setting' && args.section === 'youtube') return;
      return original(command, args, ...rest);
    };
    try {
      window.openSettingsTab('youtube'); await idle();
      assert(!$('#youtube-session-open').disabled, 'Connection must be available without loading a video');
      assert(!$('#youtube-like-button') && !$('#youtube-save-button') && !$('#youtube-account-controls'), 'Social controls removed');
      assert(!$('#youtube-session-fallback').open, 'Connection options start collapsed');
      assert($('#youtube-session-check-area').classList.contains('hidden'), 'Recovery controls stay hidden during ordinary settings');
      assert($('#youtube-connection-card').getBoundingClientRect().height < 260, 'Connection card is compact');
      assert(!$('#youtube-session-browser') && !$('#youtube-session-continue'), 'No managed-profile browser controls');
      $('#youtube-session-open').click(); await idle();
      assert(!$('#youtube-sign-in-link-area').classList.contains('hidden'), 'Link is visible');
      assert(!calls.some(c => c.command === 'open_youtube_sign_in_link'), 'Preparing a link must not launch a browser');
      $('#youtube-sign-in-launch').click(); await idle();
      assert(calls.some(c => c.command === 'open_youtube_sign_in_link'), 'Open must launch only the normal link');
      window.closeModal('settings-dialog'); window.openSettingsTab('youtube'); await idle();
      assert(!$('#youtube-session-cancel').classList.contains('hidden'), 'Closing Settings preserves the pending connection');
      delayPoll = true; await wait(() => releasePoll);
      $('#youtube-session-cancel').click(); await idle();
      releasePoll({ status: 'connected', attemptId: pending?.attemptId }); delayPoll = false;
      await new Promise(r => setTimeout(r, 50));
      assert($('#youtube-session-summary').textContent === 'Not connected', 'Late completion cannot override Cancel');
      $('#youtube-session-open').click(); await idle();
      pending.status = 'expired';
      await wait(() => !$('#youtube-session-open').classList.contains('hidden'));
      assert($('#youtube-session-status').textContent.includes('expired'), 'Expired link offers a fresh attempt');
      window.closeModal('settings-dialog'); window.openModal('youtube-modal');
      $('#yt-url-field').value = url; $('#yt-find-button').click(); await wait(() => !$('#yt-find-button').disabled);
      $('#yt-session-settings').click(); await idle();
      assert($('#youtube-session-url').value === url, 'Failed URL is retained');
      $('#youtube-session-import').click(); await idle(); assert(!saved, 'Cancelled import preserves access');
      $('#youtube-session-open').click(); await idle();
      saved = true; pending.status = 'connected';
      await wait(() => $('#youtube-session-summary').textContent === 'Connected');
      assert(!calls.some(c => /^(open|capture|continue|close)_youtube_sign_in$/.test(c.command)), 'Existing-profile flow never touches a managed browser');
      $('#youtube-session-check').click(); await idle(); assert($('#youtube-session-status').textContent.includes('expired'), 'Check errors remain actionable');
      checkFails = false; $('#youtube-session-check').click(); await idle(); assert($('#youtube-session-status').textContent.includes('accessible'), 'Check succeeds');
      $('#youtube-session-retry').click(); await wait(() => !$('#yt-find-button').disabled);
      assert(!$('#yt-play-button').disabled && $('#yt-url-field').value === url, 'Retry retains original video');
      window.closeModal('youtube-modal'); window.openSettingsTab('youtube'); await idle();
      $('#youtube-session-remove').click(); await idle(); assert(!saved, 'Remove saved access');
      importCancelled = false; $('#youtube-session-import').click(); await idle(); assert(saved, 'Manual import remains available');
      return { sameProfileFlow: true, noManagedBrowser: true, pendingSurvivesSettings: true, lateCancelRejected: true, expiryRetry: true, completionDetected: true, checkRetryImportRemove: true };
    } finally { delete window.__LINGO_MOCK_INVOKE__; }
  }})()`);
  const screenshot = join(tmpdir(), 'lingo-existing-browser-settings.png');
  const shot = await player.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(screenshot, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ ...result, screenshot }, null, 2));
} finally {
  await player.send('Fetch.disable').catch(() => {});
  await player.reload().catch(() => {});
  player.close();
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { connectionUrl, exportCookies, connectCurrentProfile } from '../src-tauri/browser-extension/background.js';

const url = `http://127.0.0.1:9876/connect/${'a'.repeat(43)}`;
const cookie = { domain: '.youtube.com', path: '/', name: 'SAPISID', value: 'synthetic-only', secure: true, httpOnly: true, session: true, hostOnly: false };
test('only opaque local connection URLs are accepted', () => {
  assert.equal(connectionUrl(url), url);
  for (const invalid of [url.replace('127.0.0.1', 'evil.invalid'), url.replace('http:', 'https:'), url.replace(':9876', ':80'), `${url}?x=1`, `${url}#x`, url.replace('/connect/', '/steal/'), url.replace('127.0.0.1', 'user:pass@127.0.0.1')]) assert.throws(() => connectionUrl(invalid));
});
test('exports only valid unpartitioned YouTube cookies, including HttpOnly', () => {
  const exported = exportCookies([cookie,
    { ...cookie, domain: '.google.com', value: 'google-secret' },
    { ...cookie, domain: '.youtube.com.evil.com', value: 'other-secret' },
    { ...cookie, expirationDate: 100, value: 'expired-secret' },
    { ...cookie, partitionKey: { topLevelSite: 'https://elsewhere.invalid' }, value: 'partitioned-secret' },
    { ...cookie, value: 'line\ninjection' }
  ], 200);
  assert(exported.includes('#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsynthetic-only'));
  for (const excluded of ['google-secret', 'other-secret', 'expired-secret', 'partitioned-secret', 'injection']) assert(!exported.includes(excluded));
  assert.throws(() => exportCookies([{ ...cookie, name: 'PREF' }]), /No signed-in/);
});
test('uses the sender tab cookie store and sends secrets only directly to Rust', async () => {
  const calls = [];
  const api = { cookies: {
    getAllCookieStores: async () => [{ id: 'other-profile', tabIds: [5] }, { id: 'this-profile', tabIds: [8] }],
    getAll: async filter => { assert.deepEqual(filter, { domain: 'youtube.com', storeId: 'this-profile' }); return [cookie]; }
  } };
  const fetcher = async (target, options) => {
    assert.equal(target, url);
    calls.push(options);
    return { ok: true, text: async () => '<meta name="lingo-browser-connector" content="1">' };
  };
  assert.deepEqual(await connectCurrentProfile({ frameId: 0, url, tab: { id: 8 } }, api, fetcher), { ok: true });
  assert.equal(calls.length, 2);
  assert(!calls[0].body);
  assert(calls[1].body.includes('synthetic-only'));
  assert.equal(calls[1].redirect, 'error');
  assert.equal(calls[1].credentials, 'omit');
});
test('untrusted senders, incognito and stale links never read cookies', async () => {
  const api = { cookies: { getAllCookieStores: () => { throw new Error('Cookies must not be read'); } } };
  for (const sender of [{ frameId: 1, url, tab: { id: 8 } }, { frameId: 0, url, tab: { id: 8, incognito: true } }, { frameId: 0, url: 'https://evil.invalid', tab: { id: 8 } }]) {
    await assert.rejects(connectCurrentProfile(sender, api, () => { throw new Error('Must not fetch'); }));
  }
  await assert.rejects(connectCurrentProfile({ frameId: 0, url, tab: { id: 8 } }, api, async () => ({ ok: false })), /no longer waiting/);
});
test('permissions stay limited and the page requires a trusted user click', async () => {
  const base = new URL('../src-tauri/browser-extension/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  assert.deepEqual(manifest.permissions, ['cookies']);
  assert.deepEqual(manifest.host_permissions, ['https://*.youtube.com/*', 'http://127.0.0.1/*']);
  assert.equal(manifest.content_scripts.length, 1);
  assert(!manifest.externally_connectable);
  const content = await readFile(new URL('content.js', base), 'utf8');
  assert(content.includes('!event.isTrusted'));
  assert(!content.includes('postMessage'));
  assert(!content.includes('cookies.getAll'));
});

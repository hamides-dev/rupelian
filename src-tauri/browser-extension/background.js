// Cookie values stay in the worker until sent directly to Rust, never the page.
export function connectionUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024
      || url.username || url.password || url.search || url.hash || !/^\/connect\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) {
    throw new Error('Prepare a new connection link in Rupelian.');
  }
  return url.href;
}

export function exportCookies(cookies, now = Date.now() / 1000) {
  const rows = ['# Netscape HTTP Cookie File', '# Rupelian browser connector', ''];
  let signedIn = false;
  for (const cookie of cookies) {
    const domain = cookie.domain?.replace(/^\./, '');
    if (domain !== 'youtube.com' && !domain?.endsWith('.youtube.com')) continue;
    if (cookie.partitionKey || cookie.expirationDate && cookie.expirationDate <= now) continue;
    const fields = [cookie.domain, cookie.path, cookie.name, cookie.value];
    if (fields.some(value => typeof value !== 'string' || /[\t\r\n\0]/.test(value)) || !cookie.path.startsWith('/')) continue;
    if (['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID', 'LOGIN_INFO'].includes(cookie.name) && cookie.value) signedIn = true;
    rows.push([
      `${cookie.httpOnly ? '#HttpOnly_' : ''}${cookie.domain}`,
      cookie.hostOnly ? 'FALSE' : 'TRUE', cookie.path, cookie.secure ? 'TRUE' : 'FALSE',
      cookie.session ? 0 : Math.max(0, Math.floor(cookie.expirationDate || 0)), cookie.name, cookie.value
    ].join('\t'));
  }
  if (!signedIn) throw new Error('No signed-in YouTube account was found in this profile. Open YouTube in another tab of this same browser, check your account, then try Connect again.');
  return `${rows.join('\n')}\n`;
}

export async function connectCurrentProfile(sender, api = chrome, fetcher = fetch) {
  if (sender.frameId !== 0 || !sender.tab || sender.tab.incognito) throw new Error('Open the link in your normal signed-in browser tab.');
  const url = connectionUrl(sender.url);
  const page = await fetcher(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!page.ok || !(await page.text()).includes('name="lingo-browser-connector" content="1"')) throw new Error('This link is no longer waiting. Prepare a new connection link in Rupelian.');
  const stores = await api.cookies.getAllCookieStores();
  const store = stores.find(item => item.tabIds.includes(sender.tab.id));
  if (!store) throw new Error('Could not identify this browser profile. Reload this tab and try again.');
  const cookies = await api.cookies.getAll({ domain: 'youtube.com', storeId: store.id });
  const response = await fetcher(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: exportCookies(cookies), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Rupelian did not save access. The link may have expired or been cancelled. Prepare a new link and try again.');
  return { ok: true };
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== 'lingo-connect-current-profile') return;
    connectCurrentProfile(sender).then(reply).catch(error => reply({ ok: false, error: error.message }));
    return true;
  });
}

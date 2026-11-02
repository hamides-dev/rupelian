(() => {
  if (window.top !== window || !/^\/connect\/[A-Za-z0-9_-]{43}$/.test(location.pathname)
      || document.querySelector('meta[name="lingo-browser-connector"]')?.content !== '1') return;
  const host = document.getElementById('connector-control');
  if (!host) return;
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = 'button{font:600 16px system-ui;color:white;background:#c81920;border:0;border-radius:10px;padding:15px 24px;cursor:pointer}button:disabled{opacity:.6;cursor:default}p{color:#bbb;font:14px/1.7 system-ui}';
  const button = document.createElement('button');
  button.textContent = 'Connect my current YouTube account';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Uses the YouTube account already signed in in this browser profile. Only YouTube access is sent to Rupelian on this PC.';
  root.append(style, button, status);
  document.getElementById('extension-help').hidden = true;
  document.getElementById('connector-status').textContent = 'Your existing browser profile is ready. Click Connect below.';
  button.addEventListener('click', async event => {
    if (!event.isTrusted || button.disabled) return;
    button.disabled = true;
    status.textContent = 'Connecting your existing account…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'lingo-connect-current-profile' });
      if (!result?.ok) throw new Error(result?.error || 'The connector did not respond. Reload this tab and try again.');
      button.textContent = 'Connected';
      status.textContent = 'Connected. Return to Rupelian. You can close this tab; your browser and account stay open.';
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
})();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'gh_api') {
    handleApi(msg).then(sendResponse).catch(e => sendResponse({ _error: e.message, _code: e.code || 'api_error' }));
    return true;
  }
  if (msg.type === 'set_token') {
    chrome.storage.local.set({ gh_token: msg.token }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'clear_token') {
    chrome.storage.local.remove('gh_token', () => sendResponse({ ok: true }));
    return true;
  }
});

async function handleApi({ method, path, body, pageToken }) {
  const store = await new Promise(resolve => chrome.storage.local.get('gh_token', resolve));
  // Prefer an explicitly saved PAT; fall back to the session token in the page.
  const token = store.gh_token || pageToken;

  if (!token) {
    throw Object.assign(new Error('No token available'), { code: 'no_token' });
  }

  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': `token ${token}`,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  // If the page token was rejected, ask the user for a real PAT.
  if (res.status === 401) {
    if (!store.gh_token) {
      // Page token didn't work — need an explicit PAT
      throw Object.assign(
        new Error('Session token not accepted by GitHub API — please enter a Personal Access Token'),
        { code: 'no_token' }
      );
    }
    // Stored PAT is invalid/expired — clear it and re-prompt
    chrome.storage.local.remove('gh_token');
    throw Object.assign(new Error('Token expired or revoked — please re-enter it'), { code: 'invalid_token' });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  if (res.status === 204 || method === 'DELETE') return null;
  return res.json();
}

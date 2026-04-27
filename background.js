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

async function handleApi({ method, path, body }) {
  const store = await new Promise(resolve => chrome.storage.local.get('gh_token', resolve));
  const token = store.gh_token;

  if (!token) {
    throw Object.assign(new Error('No GitHub token — please enter a Personal Access Token'), { code: 'no_token' });
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

  if (res.status === 401) {
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

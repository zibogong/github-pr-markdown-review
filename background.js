// ── OAuth config ───────────────────────────────────────────────────────────
// Register at: https://github.com/settings/applications/new
//   Homepage URL:            https://github.com
//   Authorization callback:  https://<EXTENSION_ID>.chromiumapp.org/
//   (find your extension ID at chrome://extensions)
const CLIENT_ID     = '';   // paste your OAuth App client_id here
const CLIENT_SECRET = '';   // paste your OAuth App client_secret here

// ── PKCE helpers ───────────────────────────────────────────────────────────

function generateVerifier() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateChallenge(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── OAuth flow ─────────────────────────────────────────────────────────────

async function launchOAuth() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw Object.assign(
      new Error('OAuth not configured — set CLIENT_ID and CLIENT_SECRET in background.js'),
      { code: 'not_configured' }
    );
  }

  const verifier     = generateVerifier();
  const challenge    = await generateChallenge(verifier);
  const redirectUri  = chrome.identity.getRedirectURL();

  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'repo');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const redirected = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, url => {
      if (chrome.runtime.lastError || !url) {
        reject(new Error(chrome.runtime.lastError?.message || 'Auth cancelled'));
      } else {
        resolve(url);
      }
    });
  });

  const code = new URL(redirected).searchParams.get('code');
  if (!code) throw new Error('No auth code in redirect');

  // Exchange code for token. Background workers bypass CORS for host_permissions,
  // so this POST to github.com works without a backend.
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri:  redirectUri,
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.error_description || `OAuth failed: ${data.error}`);
  }

  await chrome.storage.local.set({ gh_token: data.access_token });
  return data.access_token;
}

// ── Message handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'launch_oauth') {
    launchOAuth().then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ _error: e.message, _code: e.code }));
    return true;
  }
  if (msg.type === 'gh_api') {
    handleApi(msg).then(sendResponse)
      .catch(e => sendResponse({ _error: e.message, _code: e.code || 'api_error' }));
    return true;
  }
  if (msg.type === 'clear_token') {
    chrome.storage.local.remove('gh_token', () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'get_redirect_url') {
    sendResponse({ url: chrome.identity.getRedirectURL() });
  }
});

// ── GitHub API (PAT / OAuth token fallback) ────────────────────────────────

async function handleApi({ method, path, body }) {
  const store = await new Promise(resolve => chrome.storage.local.get('gh_token', resolve));
  const token = store.gh_token;

  if (!token) {
    throw Object.assign(new Error('Not authenticated'), { code: 'no_token' });
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
    throw Object.assign(new Error('Token expired — please log in again'), { code: 'invalid_token' });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  if (res.status === 204 || method === 'DELETE') return null;
  return res.json();
}

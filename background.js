// Background service worker — proxies GitHub API calls from the content script.
// Background workers bypass CORS for hosts in host_permissions, so
// credentials: 'include' works here even though api.github.com returns ACAO: *.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'gh_api') return false;
  handleApi(msg).then(sendResponse).catch(e => sendResponse({ _error: e.message }));
  return true; // keep message channel open for async response
});

async function handleApi({ method, path, body }) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  if (res.status === 204 || method === 'DELETE') return null;
  return res.json();
}

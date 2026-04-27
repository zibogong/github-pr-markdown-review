// Receives POST/DELETE requests from content scripts and re-executes them in
// the page's MAIN world so the browser treats them as same-origin requests,
// which sends all session cookies (including SameSite=Strict).
//
// chrome.scripting.executeScript with world:'MAIN' bypasses page CSP
// (extension injection is trusted) and runs with the page's JS context.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return false;

  if (msg.type === 'PRMC_POST_COMMENT') {
    const { owner, repo, number, csrf, body } = msg;
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (url, csrf, body) => {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: new URLSearchParams({
            utf8: '✓',
            authenticity_token: csrf,
            'comment[body]': body,
          }).toString(),
        });
        // fetch follows redirects; a successful post lands on the PR page (200)
        return { status: res.status, ok: res.ok };
      },
      args: [
        `https://github.com/${owner}/${repo}/issues/${number}/comments`,
        csrf,
        body,
      ],
    }).then(results => {
      sendResponse({ success: true, result: results?.[0]?.result });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // keep the message channel open for the async response
  }

  if (msg.type === 'PRMC_DELETE_COMMENT') {
    const { owner, repo, commentId, csrf } = msg;
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (url, csrf) => {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: new URLSearchParams({
            utf8: '✓',
            authenticity_token: csrf,
            _method: 'delete',
          }).toString(),
        });
        return { status: res.status, ok: res.ok };
      },
      args: [
        `https://github.com/${owner}/${repo}/issues/comments/${commentId}`,
        csrf,
      ],
    }).then(results => {
      sendResponse({ success: true, result: results?.[0]?.result });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

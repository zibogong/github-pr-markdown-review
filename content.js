(() => {
  'use strict';

  // ── GitHub API layer ───────────────────────────────────────────────────────

  function getPrInfo() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], number: parseInt(m[3]) } : null;
  }

  const prInfo = getPrInfo();
  const MARKER = '<!-- prmc:';

  function ghFetch(method, path, body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'gh_api', method, path, body }, (result) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (result?._error) {
          const err = new Error(result._error);
          err.code = result._code;
          return reject(err);
        }
        resolve(result);
      });
    });
  }

  function setToken(token) {
    return new Promise(resolve => chrome.runtime.sendMessage({ type: 'set_token', token }, resolve));
  }

  function buildCommentBody(comment) {
    const meta = JSON.stringify({
      quote: comment.quote,
      elementXPath: comment.elementXPath,
      startOffset: comment.startOffset,
      endOffset: comment.endOffset,
    });
    const quoteLine = comment.quote
      ? `> ${comment.quote.slice(0, 300).replace(/\n/g, '\n> ')}\n\n`
      : '';
    return `${quoteLine}${comment.commentText || ''}\n\n${MARKER}${meta} -->`;
  }

  function parseGitHubComment(c) {
    const metaMatch = c.body.match(/<!-- prmc:(\{.*?\}) -->/s);
    if (!metaMatch) return null;
    try {
      const meta = JSON.parse(metaMatch[1]);
      const commentText = c.body
        .replace(/\n\n<!-- prmc:.*? -->/s, '')
        .replace(/^(> [^\n]*\n)+\n/, '')
        .trim();
      return {
        id: String(c.id),
        githubCommentId: c.id,
        quote: meta.quote || '',
        elementXPath: meta.elementXPath,
        startOffset: meta.startOffset,
        endOffset: meta.endOffset,
        commentText,
        timestamp: new Date(c.created_at).getTime(),
        author: c.user.login,
        avatarUrl: c.user.avatar_url,
      };
    } catch { return null; }
  }

  async function fetchPageComments() {
    if (!prInfo) return [];
    const { owner, repo, number } = prInfo;
    const data = await ghFetch('GET', `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
    return data.filter(c => c.body.includes(MARKER)).map(parseGitHubComment).filter(Boolean);
  }

  async function postComment(comment) {
    const { owner, repo, number } = prInfo;
    const res = await ghFetch('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, {
      body: buildCommentBody(comment),
    });
    return res.id;
  }

  async function patchComment(githubCommentId, comment) {
    const { owner, repo } = prInfo;
    await ghFetch('PATCH', `/repos/${owner}/${repo}/issues/comments/${githubCommentId}`, {
      body: buildCommentBody(comment),
    });
  }

  async function deleteGhComment(githubCommentId) {
    const { owner, repo } = prInfo;
    await ghFetch('DELETE', `/repos/${owner}/${repo}/issues/comments/${githubCommentId}`);
  }

  // ── In-memory state ────────────────────────────────────────────────────────

  let activeComments = [];

  // ── Utilities ──────────────────────────────────────────────────────────────

  function getXPath(node) {
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    const parts = [];
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
      let idx = 1;
      let sib = node.previousSibling;
      while (sib) {
        if (sib.nodeType === Node.ELEMENT_NODE && sib.tagName === node.tagName) idx++;
        sib = sib.previousSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
      node = node.parentNode;
    }
    return '//' + parts.join('/');
  }

  function resolveXPath(xpath) {
    try {
      return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch { return null; }
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────

  let sidebar, sidebarList, openBtn;

  function buildSidebar() {
    if (document.getElementById('prmc-sidebar')) return;

    sidebar = document.createElement('div');
    sidebar.id = 'prmc-sidebar';
    sidebar.classList.add('prmc-hidden');
    sidebar.innerHTML = `
      <div id="prmc-sidebar-header">
        <span>PR Comments</span>
        <button id="prmc-sidebar-toggle" title="Close">×</button>
      </div>
      <div id="prmc-sidebar-list"></div>`;
    document.body.appendChild(sidebar);

    sidebarList = sidebar.querySelector('#prmc-sidebar-list');
    sidebar.querySelector('#prmc-sidebar-toggle').addEventListener('click', closeSidebar);

    openBtn = document.createElement('button');
    openBtn.id = 'prmc-open-btn';
    openBtn.textContent = 'Comments';
    openBtn.classList.add('prmc-hidden');
    openBtn.addEventListener('click', openSidebar);
    document.body.appendChild(openBtn);
  }

  function openSidebar() {
    sidebar.classList.remove('prmc-hidden');
    openBtn.classList.add('prmc-hidden');
    document.body.classList.add('prmc-sidebar-open');
  }

  function closeSidebar() {
    sidebar.classList.add('prmc-hidden');
    openBtn.classList.remove('prmc-hidden');
    document.body.classList.remove('prmc-sidebar-open');
  }

  function renderSidebar(comments) {
    sidebarList.innerHTML = '';
    if (comments.length === 0) {
      sidebarList.innerHTML = '<div id="prmc-sidebar-empty">No comments yet.<br>Select text in the rich diff to add one.</div>';
      return;
    }
    const sorted = comments.slice().sort((a, b) => {
      const ya = resolveXPath(a.elementXPath)?.getBoundingClientRect().top ?? 0;
      const yb = resolveXPath(b.elementXPath)?.getBoundingClientRect().top ?? 0;
      return ya - yb;
    });
    sorted.forEach(c => sidebarList.appendChild(buildCard(c)));
  }

  const updateTimers = {};

  function buildCard(comment) {
    const card = document.createElement('div');
    card.className = 'prmc-comment-card';
    card.dataset.commentId = comment.id;

    const anchorExists = !!resolveXPath(comment.elementXPath);
    const quoteClass = anchorExists ? 'prmc-comment-quote' : 'prmc-comment-quote prmc-lost';
    const quoteText = anchorExists ? comment.quote : '(anchor lost — content may have changed)';

    card.innerHTML = `
      <div class="prmc-comment-meta">
        <img class="prmc-avatar" src="${escapeHtml(comment.avatarUrl)}" alt="">
        <a class="prmc-author" href="https://github.com/${escapeHtml(comment.author)}" target="_blank">${escapeHtml(comment.author)}</a>
        <span class="prmc-date">${formatDate(comment.timestamp)}</span>
      </div>
      <div class="${quoteClass}" title="${escapeHtml(comment.quote)}">${escapeHtml(quoteText.slice(0, 120))}</div>
      <textarea class="prmc-comment-body" placeholder="Add a comment…">${escapeHtml(comment.commentText || '')}</textarea>
      <div class="prmc-comment-footer">
        <span class="prmc-save-status"></span>
        <button class="prmc-comment-delete">Delete</button>
      </div>`;

    const textarea = card.querySelector('.prmc-comment-body');
    const statusEl = card.querySelector('.prmc-save-status');

    textarea.addEventListener('input', () => {
      clearTimeout(updateTimers[comment.id]);
      statusEl.textContent = 'Saving…';
      updateTimers[comment.id] = setTimeout(async () => {
        comment.commentText = textarea.value;
        try {
          await patchComment(comment.githubCommentId, comment);
          statusEl.textContent = 'Saved';
          setTimeout(() => { statusEl.textContent = ''; }, 2000);
        } catch {
          statusEl.textContent = 'Save failed';
        }
      }, 1000);
    });

    card.querySelector('.prmc-comment-delete').addEventListener('click', () => removeComment(comment));

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('prmc-comment-delete') || e.target.tagName === 'TEXTAREA') return;
      const mark = document.querySelector(`mark.prmc-highlight[data-comment-id="${comment.id}"]`);
      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mark.classList.add('prmc-active');
        setTimeout(() => mark.classList.remove('prmc-active'), 1500);
      }
    });

    return card;
  }

  // ── Highlights ─────────────────────────────────────────────────────────────

  function applyHighlight(comment) {
    const anchor = resolveXPath(comment.elementXPath);
    if (!anchor) return;

    const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
    let charCount = 0, startNode = null, endNode = null, startOff = 0, endOff = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const len = node.nodeValue.length;
      if (!startNode && charCount + len > comment.startOffset) {
        startNode = node;
        startOff = comment.startOffset - charCount;
      }
      if (!endNode && charCount + len >= comment.endOffset) {
        endNode = node;
        endOff = comment.endOffset - charCount;
        break;
      }
      charCount += len;
    }

    if (!startNode || !endNode) return;

    try {
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);

      const mark = document.createElement('mark');
      mark.className = 'prmc-highlight';
      mark.dataset.commentId = comment.id;
      mark.title = comment.commentText || '';
      mark.addEventListener('click', () => {
        openSidebar();
        const card = sidebarList.querySelector(`.prmc-comment-card[data-comment-id="${comment.id}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          card.classList.add('prmc-active');
          setTimeout(() => card.classList.remove('prmc-active'), 1500);
        }
      });
      range.surroundContents(mark);
    } catch { /* range spans elements — sidebar still shows the comment */ }
  }

  function removeHighlight(commentId) {
    const mark = document.querySelector(`mark.prmc-highlight[data-comment-id="${commentId}"]`);
    if (!mark) return;
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }

  // ── Comment CRUD ───────────────────────────────────────────────────────────

  async function addComment(comment) {
    try {
      const githubId = await postComment(comment);
      comment.id = String(githubId);
      comment.githubCommentId = githubId;
      activeComments.push(comment);
      applyHighlight(comment);
      renderSidebar(activeComments);
      openBtn.classList.remove('prmc-hidden');
      openSidebar();
      setTimeout(() => {
        const card = sidebarList.querySelector(`.prmc-comment-card[data-comment-id="${comment.id}"]`);
        if (card) card.querySelector('textarea').focus();
      }, 50);
    } catch (e) {
      if (e.code === 'no_token' || e.code === 'invalid_token') {
        showTokenPrompt(e.code === 'invalid_token' ? e.message : null, comment);
      } else {
        console.error('[prmc] Failed to post comment:', e);
        showError('Could not post comment: ' + e.message);
      }
    }
  }

  function showTokenPrompt(errorMsg, pendingComment) {
    if (document.getElementById('prmc-token-modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'prmc-token-modal';
    overlay.innerHTML = `
      <div id="prmc-token-dialog">
        <h3>GitHub Token Required</h3>
        ${errorMsg ? `<p class="prmc-token-error">${escapeHtml(errorMsg)}</p>` : ''}
        <p>Create a <a href="https://github.com/settings/tokens/new?scopes=repo&description=PR+Markdown+Commenter" target="_blank">Personal Access Token</a> with <code>repo</code> scope, then paste it below.</p>
        <input id="prmc-token-input" type="password" placeholder="ghp_…" autocomplete="off" spellcheck="false">
        <div id="prmc-token-buttons">
          <button id="prmc-token-cancel">Cancel</button>
          <button id="prmc-token-save">Save &amp; post</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#prmc-token-input');
    input.focus();

    overlay.querySelector('#prmc-token-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#prmc-token-save').addEventListener('click', async () => {
      const token = input.value.trim();
      if (!token) { input.focus(); return; }
      await setToken(token);
      overlay.remove();
      if (pendingComment) addComment(pendingComment);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') overlay.querySelector('#prmc-token-save').click();
      if (e.key === 'Escape') overlay.remove();
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  async function removeComment(comment) {
    removeHighlight(comment.id);
    activeComments = activeComments.filter(c => c.id !== comment.id);
    renderSidebar(activeComments);
    if (activeComments.length === 0) { closeSidebar(); openBtn.classList.add('prmc-hidden'); }
    try {
      await deleteGhComment(comment.githubCommentId);
    } catch (e) {
      console.error('[prmc] Failed to delete comment:', e);
    }
  }

  function showError(msg) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#cf222e;color:#fff;padding:10px 14px;border-radius:6px;font-size:13px;z-index:99999;font-family:sans-serif';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ── Floating "Add comment" button ──────────────────────────────────────────

  let addBtn = null;
  let pendingRange = null;

  function showAddBtn(x, y) {
    if (!addBtn) {
      addBtn = document.createElement('button');
      addBtn.id = 'prmc-add-btn';
      addBtn.textContent = '💬 Comment';
      addBtn.addEventListener('mousedown', e => e.preventDefault());
      addBtn.addEventListener('click', () => {
        hideAddBtn();
        if (!pendingRange) return;

        const selectedText = pendingRange.toString().trim();
        if (!selectedText) return;

        const anchorNode = pendingRange.commonAncestorContainer;
        const anchorEl = anchorNode.nodeType === Node.TEXT_NODE ? anchorNode.parentNode : anchorNode;
        const xpath = getXPath(anchorEl);

        const walker = document.createTreeWalker(anchorEl, NodeFilter.SHOW_TEXT);
        let charCount = 0, startOffset = 0, endOffset = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node === pendingRange.startContainer) startOffset = charCount + pendingRange.startOffset;
          if (node === pendingRange.endContainer) { endOffset = charCount + pendingRange.endOffset; break; }
          charCount += node.nodeValue.length;
        }

        window.getSelection().removeAllRanges();
        pendingRange = null;

        const comment = {
          id: crypto.randomUUID(), // temporary until GitHub assigns real ID
          githubCommentId: null,
          quote: selectedText,
          elementXPath: xpath,
          startOffset,
          endOffset,
          commentText: '',
          timestamp: Date.now(),
          author: document.querySelector('meta[name="user-login"]')?.content || 'you',
          avatarUrl: '',
        };
        addComment(comment);
      });
      document.body.appendChild(addBtn);
    }
    addBtn.style.left = `${x}px`;
    addBtn.style.top = `${y}px`;
    addBtn.style.display = 'block';
  }

  function hideAddBtn() {
    if (addBtn) addBtn.style.display = 'none';
  }

  // ── Init rich diff layer ───────────────────────────────────────────────────

  async function initCommentLayer(article) {
    try {
      activeComments = await fetchPageComments();
    } catch (e) {
      console.warn('[prmc] Could not load comments from GitHub API:', e);
      activeComments = [];
    }

    renderSidebar(activeComments);
    activeComments.forEach(applyHighlight);
    if (activeComments.length > 0) openBtn.classList.remove('prmc-hidden');

    document.addEventListener('mouseup', () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideAddBtn(); return; }
        const range = sel.getRangeAt(0);
        if (!article.contains(range.commonAncestorContainer)) { hideAddBtn(); return; }
        pendingRange = range.cloneRange();
        const rect = range.getBoundingClientRect();
        showAddBtn(rect.right + window.scrollX + 6, rect.top + window.scrollY - 4);
      }, 10);
    });

    document.addEventListener('mousedown', (e) => {
      if (addBtn && e.target !== addBtn) hideAddBtn();
    });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  function bootstrap() {
    if (!prInfo) return; // not a PR page
    buildSidebar();

    const existing = document.querySelector('article.markdown-body.entry-content');
    if (existing && !existing.dataset.commentEnabled) {
      existing.dataset.commentEnabled = 'true';
      initCommentLayer(existing);
    }

    const observer = new MutationObserver(() => {
      const article = document.querySelector('article.markdown-body.entry-content');
      if (article && !article.dataset.commentEnabled) {
        article.dataset.commentEnabled = 'true';
        initCommentLayer(article);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  bootstrap();
})();

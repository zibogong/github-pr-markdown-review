(() => {
  'use strict';

  // ── GitHub API layer ───────────────────────────────────────────────────────

  function getPrInfo() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], number: parseInt(m[3]) } : null;
  }

  const prInfo = getPrInfo();
  const MARKER = '<!-- prmc:';

  // ── GitHub integration — no token needed ──────────────────────────────────
  //
  // Writes: POST to github.com using the CSRF token already on the page +
  //         the user's existing session cookie. Identical to clicking Submit
  //         on GitHub's own comment form.
  //
  // Reads:  GET from api.github.com — no auth required for public repos.

  function getCsrfToken() {
    return (
      document.querySelector('meta[name="csrf-token"]')?.content ||
      document.querySelector('meta[name="user-csrf-token"]')?.content ||
      document.querySelector('input[name="authenticity_token"]')?.value ||
      document.querySelector('[data-csrf]')?.dataset.csrf ||
      document.querySelector('[data-authenticity-token]')?.dataset.authenticityToken ||
      document.querySelector('form[action*="comments"] input[name="authenticity_token"]')?.value
    );
  }

  function getVerifiedCsrfToken() {
    const token = getCsrfToken();
    if (!token) {
      const metas = [...document.querySelectorAll('meta[name]')].map(m => m.name).join(', ');
      console.warn('[prmc] CSRF token not found. Meta tags on page:', metas);
    } else {
      console.debug('[prmc] CSRF token found, length:', token.length);
    }
    return token;
  }

  function buildCommentBody(comment) {
    const meta = JSON.stringify({
      quote: comment.quote,
      elementXPath: comment.elementXPath,
      startOffset: comment.startOffset,
      endOffset: comment.endOffset,
    });
    // Escape --> inside the JSON so it can't accidentally close the HTML comment
    const safeJson = meta.replace(/-->/g, '--\\>');
    const quoteLine = comment.quote
      ? `> ${comment.quote.slice(0, 300).replace(/\n/g, '\n> ')}\n\n`
      : '';
    return `${quoteLine}${comment.commentText || ''}\n\n${MARKER}${safeJson} -->`;
  }

  function parseGitHubComment(c) {
    const metaMatch = c.body.match(/<!-- prmc:(\{.*?\}) -->/s);
    if (!metaMatch) return null;
    try {
      const rawJson = metaMatch[1].replace(/--\\>/g, '-->');
      const meta = JSON.parse(rawJson);
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
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
      { headers: { 'Accept': 'application/vnd.github+json' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.filter(c => c.body.includes(MARKER)).map(parseGitHubComment).filter(Boolean);
  }

  // Delegate the actual fetch to the background worker, which re-injects it
  // into the page's MAIN world. That makes the browser treat it as same-origin,
  // so SameSite=Strict session cookies are included — unlike a direct fetch()
  // from a content script, which Chrome considers cross-context.
  async function postComment(comment) {
    const { owner, repo, number } = prInfo;
    const csrf = getVerifiedCsrfToken();
    if (!csrf) throw new Error('CSRF token not found — are you logged in to GitHub?');

    const response = await chrome.runtime.sendMessage({
      type: 'PRMC_POST_COMMENT',
      owner, repo, number, csrf,
      body: buildCommentBody(comment),
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Extension background did not respond');
    }
    if (!response.result?.ok) {
      throw new Error(`GitHub returned ${response.result?.status} — check that you are logged in`);
    }

    // Poll api.github.com until our new comment appears (up to ~5s)
    const posted = Date.now();
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(r => setTimeout(r, 900));
      const fresh = await fetchPageComments();
      const match = fresh.find(c =>
        c.quote === comment.quote &&
        c.elementXPath === comment.elementXPath &&
        c.timestamp >= posted - 5000
      );
      if (match) return match;
    }
    return null;
  }

  async function deleteGhComment(githubCommentId) {
    if (!githubCommentId) return;
    const { owner, repo } = prInfo;
    const csrf = getVerifiedCsrfToken();
    if (!csrf) return;

    await chrome.runtime.sendMessage({
      type: 'PRMC_DELETE_COMMENT',
      owner, repo, commentId: githubCommentId, csrf,
    });
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

  function currentUserLogin() {
    return document.querySelector('meta[name="user-login"]')?.content || '';
  }

  function currentUserAvatar() {
    const login = currentUserLogin();
    return login ? `https://github.com/${login}.png?size=40` : '';
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

  function buildCard(comment) {
    const card = document.createElement('div');
    card.className = 'prmc-comment-card';
    card.dataset.commentId = comment.id;

    const anchorExists = !!resolveXPath(comment.elementXPath);
    const quoteClass = anchorExists ? 'prmc-comment-quote' : 'prmc-comment-quote prmc-lost';
    const quoteText = anchorExists ? comment.quote : '(anchor lost — content may have changed)';

    card.innerHTML = `
      <div class="prmc-comment-meta">
        <img class="prmc-avatar" src="${escapeHtml(comment.avatarUrl || currentUserAvatar())}" alt="">
        <a class="prmc-author" href="https://github.com/${escapeHtml(comment.author)}" target="_blank">${escapeHtml(comment.author)}</a>
        <span class="prmc-date">${formatDate(comment.timestamp)}</span>
      </div>
      <div class="${quoteClass}" title="${escapeHtml(comment.quote)}">${escapeHtml(quoteText.slice(0, 120))}</div>
      <div class="prmc-comment-text">${escapeHtml(comment.commentText || '')}</div>
      <div class="prmc-comment-footer">
        <span class="prmc-save-status"></span>
        <button class="prmc-comment-delete">Delete</button>
      </div>`;

    card.querySelector('.prmc-comment-delete').addEventListener('click', () => removeComment(comment));

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('prmc-comment-delete')) return;
      const mark = document.querySelector(`mark.prmc-highlight[data-comment-id="${comment.id}"]`);
      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mark.classList.add('prmc-active');
        setTimeout(() => mark.classList.remove('prmc-active'), 1500);
      }
    });

    return card;
  }

  function buildPostingCard(quote) {
    const card = document.createElement('div');
    card.className = 'prmc-comment-card prmc-posting';
    card.innerHTML = `
      <div class="prmc-comment-meta" style="padding:8px 8px 4px">
        <img class="prmc-avatar" src="${escapeHtml(currentUserAvatar())}" alt="">
        <span class="prmc-author">${escapeHtml(currentUserLogin() || 'you')}</span>
      </div>
      <div class="prmc-comment-quote">${escapeHtml(quote.slice(0, 120))}</div>
      <div style="padding:6px 8px 8px;font-size:12px;color:#57606a;font-style:italic">Posting to GitHub…</div>`;
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
      mark.title = comment.commentText || comment.quote;
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
    } catch { /* range spans multiple elements — highlight not possible, sidebar still shows it */ }
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
    openBtn.classList.remove('prmc-hidden');
    openSidebar();

    const postingCard = buildPostingCard(comment.quote);
    sidebarList.prepend(postingCard);

    try {
      const posted = await postComment(comment);
      postingCard.remove();

      if (!posted) {
        throw new Error('Comment may not have been saved — could not confirm with GitHub. Check the PR conversation tab.');
      }

      activeComments.push(posted);
      applyHighlight(posted);
      renderSidebar(activeComments);
    } catch (e) {
      postingCard.remove();
      renderSidebar(activeComments);
      console.error('[prmc] Failed to post comment:', e);
      showError(e.message || 'Could not post comment');
    }
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
    el.style.cssText = 'position:fixed;bottom:16px;right:320px;background:#cf222e;color:#fff;padding:10px 14px;border-radius:6px;font-size:13px;z-index:99999;font-family:sans-serif;max-width:360px;line-height:1.4';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 8000);
  }

  // ── Inline comment editor ──────────────────────────────────────────────────

  function showCommentEditor(anchorRect, commentData) {
    const existing = document.getElementById('prmc-editor');
    if (existing) existing.remove();

    const editor = document.createElement('div');
    editor.id = 'prmc-editor';

    const left = Math.min(anchorRect.left + window.scrollX, window.innerWidth - 310);
    const top = anchorRect.bottom + window.scrollY + 8;

    editor.style.cssText = `position:absolute;left:${left}px;top:${top}px;background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:10px;z-index:10001;box-shadow:0 4px 16px rgba(0,0,0,0.18);width:290px`;

    editor.innerHTML = `
      <div style="font-size:11px;color:#57606a;margin-bottom:8px;border-left:3px solid #FFD700;padding-left:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(commentData.quote.slice(0, 80))}</div>
      <textarea id="prmc-editor-text" placeholder="Add a comment…" style="width:100%;box-sizing:border-box;height:80px;border:1px solid #d0d7de;border-radius:4px;padding:6px 8px;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;resize:vertical;outline:none;color:#24292f"></textarea>
      <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px">
        <button id="prmc-editor-cancel" style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:4px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit">Cancel</button>
        <button id="prmc-editor-post" style="background:#0969da;color:#fff;border:none;border-radius:4px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;font-weight:500">Post comment</button>
      </div>`;

    document.body.appendChild(editor);

    const textarea = editor.querySelector('#prmc-editor-text');
    textarea.focus();

    editor.querySelector('#prmc-editor-cancel').addEventListener('click', () => {
      editor.remove();
      window.getSelection().removeAllRanges();
      pendingRange = null;
    });

    const doPost = () => {
      const text = textarea.value.trim();
      editor.remove();
      window.getSelection().removeAllRanges();
      pendingRange = null;

      addComment({
        id: crypto.randomUUID(),
        githubCommentId: null,
        quote: commentData.quote,
        elementXPath: commentData.elementXPath,
        startOffset: commentData.startOffset,
        endOffset: commentData.endOffset,
        commentText: text,
        timestamp: Date.now(),
        author: currentUserLogin() || 'you',
        avatarUrl: currentUserAvatar(),
      });
    };

    editor.querySelector('#prmc-editor-post').addEventListener('click', doPost);

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doPost();
      if (e.key === 'Escape') { editor.remove(); pendingRange = null; }
    });

    // Close on outside click (delayed so the button click that opened it doesn't immediately close it)
    setTimeout(() => {
      const closeOnOutside = (e) => {
        if (!editor.contains(e.target) && e.target !== addBtn) {
          editor.remove();
          pendingRange = null;
          document.removeEventListener('mousedown', closeOnOutside);
        }
      };
      document.addEventListener('mousedown', closeOnOutside);
    }, 150);
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
        if (!pendingRange) { hideAddBtn(); return; }

        const selectedText = pendingRange.toString().trim();
        if (!selectedText) { hideAddBtn(); return; }

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

        const rect = pendingRange.getBoundingClientRect();
        hideAddBtn();

        showCommentEditor(rect, {
          quote: selectedText,
          elementXPath: xpath,
          startOffset,
          endOffset,
        });
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
      if (addBtn && e.target !== addBtn && !document.getElementById('prmc-editor')?.contains(e.target)) {
        hideAddBtn();
      }
    });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  function bootstrap() {
    if (!prInfo) return;
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

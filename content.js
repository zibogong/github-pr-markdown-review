(() => {
  'use strict';

  const STORAGE_KEY = 'prmc_comments';
  const prUrl = location.href.split('?')[0].replace(/#.*$/, '');

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
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    } catch {
      return null;
    }
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function loadComments(cb) {
    chrome.storage.local.get(STORAGE_KEY, (data) => cb(data[STORAGE_KEY] || []));
  }

  function saveComments(comments) {
    chrome.storage.local.set({ [STORAGE_KEY]: comments });
  }

  function pageComments(all) {
    return all.filter(c => c.prUrl === prUrl);
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────

  let sidebar, sidebarList, openBtn;

  function buildSidebar() {
    if (document.getElementById('prmc-sidebar')) return;

    sidebar = document.createElement('div');
    sidebar.id = 'prmc-sidebar';
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
    openBtn.title = 'Open comments panel';
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
    const mine = pageComments(comments);
    if (mine.length === 0) {
      sidebarList.innerHTML = '<div id="prmc-sidebar-empty">No comments yet.<br>Select text in the rich diff to add one.</div>';
      return;
    }
    // Sort by vertical position of anchor element
    const sorted = mine.slice().sort((a, b) => {
      const ea = resolveXPath(a.elementXPath);
      const eb = resolveXPath(b.elementXPath);
      const ya = ea ? ea.getBoundingClientRect().top : 0;
      const yb = eb ? eb.getBoundingClientRect().top : 0;
      return ya - yb;
    });
    sorted.forEach(c => sidebarList.appendChild(buildCard(c, comments)));
  }

  function buildCard(comment, allComments) {
    const card = document.createElement('div');
    card.className = 'prmc-comment-card';
    card.dataset.commentId = comment.id;

    const anchorExists = !!resolveXPath(comment.elementXPath);
    const quoteClass = anchorExists ? 'prmc-comment-quote' : 'prmc-comment-quote prmc-lost';
    const quoteTitle = anchorExists ? comment.quote : '(anchor lost — content may have changed)';

    card.innerHTML = `
      <div class="${quoteClass}" title="${escapeHtml(comment.quote)}">${escapeHtml(quoteTitle.slice(0, 120))}</div>
      <textarea class="prmc-comment-body" placeholder="Add a comment…">${escapeHtml(comment.commentText || '')}</textarea>
      <div class="prmc-comment-footer">
        <span>${formatDate(comment.timestamp)}</span>
        <button class="prmc-comment-delete" data-id="${comment.id}">Delete</button>
      </div>`;

    // Save comment text on blur
    card.querySelector('.prmc-comment-body').addEventListener('blur', (e) => {
      loadComments(all => {
        const idx = all.findIndex(c => c.id === comment.id);
        if (idx !== -1) {
          all[idx].commentText = e.target.value;
          saveComments(all);
        }
      });
    });

    // Delete
    card.querySelector('.prmc-comment-delete').addEventListener('click', () => {
      removeComment(comment.id);
    });

    // Click card → highlight the mark
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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Highlights ─────────────────────────────────────────────────────────────

  function applyHighlight(comment) {
    const anchor = resolveXPath(comment.elementXPath);
    if (!anchor) return;

    // Walk text nodes within anchor to find startOffset/endOffset
    const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
    let charCount = 0;
    let startNode = null, endNode = null, startOff = 0, endOff = 0;

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
      mark.title = comment.commentText || '(no comment yet)';
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
    } catch {
      // Range spans multiple elements — skip highlight, comment still shows in sidebar
    }
  }

  function removeHighlight(commentId) {
    const mark = document.querySelector(`mark.prmc-highlight[data-comment-id="${commentId}"]`);
    if (!mark) return;
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }

  // ── Comment CRUD ───────────────────────────────────────────────────────────

  function addComment(comment) {
    loadComments(all => {
      const updated = [...all, comment];
      saveComments(updated);
      applyHighlight(comment);
      renderSidebar(updated);
      openSidebar();
    });
  }

  function removeComment(id) {
    loadComments(all => {
      const updated = all.filter(c => c.id !== id);
      saveComments(updated);
      removeHighlight(id);
      renderSidebar(updated);
    });
  }

  // ── Floating "Add comment" button ──────────────────────────────────────────

  let addBtn = null;
  let pendingRange = null;

  function showAddBtn(x, y) {
    if (!addBtn) {
      addBtn = document.createElement('button');
      addBtn.id = 'prmc-add-btn';
      addBtn.textContent = '💬 Comment';
      addBtn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent selection loss
      });
      addBtn.addEventListener('click', () => {
        hideAddBtn();
        if (!pendingRange) return;

        const sel = window.getSelection();
        const selectedText = pendingRange.toString().trim();
        if (!selectedText) return;

        const anchorNode = pendingRange.commonAncestorContainer;
        const anchorEl = anchorNode.nodeType === Node.TEXT_NODE ? anchorNode.parentNode : anchorNode;

        // Compute offsets relative to all text in the anchor element
        const fullText = anchorEl.textContent;
        const xpath = getXPath(anchorEl);

        // Walk text nodes to find absolute offsets
        const walker = document.createTreeWalker(anchorEl, NodeFilter.SHOW_TEXT);
        let charCount = 0;
        let startOffset = 0, endOffset = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node === pendingRange.startContainer) startOffset = charCount + pendingRange.startOffset;
          if (node === pendingRange.endContainer) { endOffset = charCount + pendingRange.endOffset; break; }
          charCount += node.nodeValue.length;
        }

        sel.removeAllRanges();

        const comment = {
          id: crypto.randomUUID(),
          prUrl,
          quote: selectedText,
          elementXPath: xpath,
          startOffset,
          endOffset,
          commentText: '',
          timestamp: Date.now(),
        };
        addComment(comment);
        pendingRange = null;

        // Focus the new card's textarea
        setTimeout(() => {
          const card = sidebarList.querySelector(`.prmc-comment-card[data-comment-id="${comment.id}"]`);
          if (card) card.querySelector('textarea').focus();
        }, 50);
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

  function initCommentLayer(article) {
    // Load and apply existing highlights
    loadComments(all => {
      renderSidebar(all);
      pageComments(all).forEach(applyHighlight);
    });

    // Listen for text selection within the article
    document.addEventListener('mouseup', (e) => {
      // Small delay so the selection is finalized
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          hideAddBtn();
          return;
        }
        const range = sel.getRangeAt(0);
        // Check selection is inside the rich diff article
        if (!article.contains(range.commonAncestorContainer)) {
          hideAddBtn();
          return;
        }
        pendingRange = range.cloneRange();
        const rect = range.getBoundingClientRect();
        showAddBtn(rect.right + window.scrollX + 6, rect.top + window.scrollY - 4);
      }, 10);
    });

    // Hide button when clicking elsewhere
    document.addEventListener('mousedown', (e) => {
      if (addBtn && e.target !== addBtn) {
        hideAddBtn();
      }
    });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  function bootstrap() {
    buildSidebar();

    // Check if rich diff is already present
    const existing = document.querySelector('article.markdown-body.entry-content');
    if (existing && !existing.dataset.commentEnabled) {
      existing.dataset.commentEnabled = 'true';
      initCommentLayer(existing);
    }

    // Watch for rich diff being toggled on dynamically
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

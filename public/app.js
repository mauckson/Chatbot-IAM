// IAM-bot-1 chat client. It only talks to /api/chat; the Groq key never reaches the browser.
(() => {
  'use strict';

  const MAX_INPUT_CHARS = 4000;
  const HISTORY_LIMIT = 12; // recent messages sent as context (the server enforces this too)
  const HISTORY_CHAR_BUDGET = 24000;
  const REQUEST_TIMEOUT_MS = 35000; // a little longer than the server's own Groq timeout
  const SLOW_HINT_MS = 8000;
  const THEME_KEY = 'iam-bot-theme';
  const EMBEDDED = window.parent !== window;
  const EMBED_PARENT_ORIGIN = 'https://ianmauck.lovable.app'; // must match frame-ancestors in vercel.json
  const NO_RETRY = new Set(['message_too_long', 'invalid_messages', 'invalid_json', 'context_too_long']);

  const $ = (id) => document.getElementById(id);
  const els = {
    scroll: $('chat-scroll'),
    empty: $('empty-state'),
    suggestions: $('suggestions'),
    list: $('messages'),
    form: $('composer'),
    input: $('composer-input'),
    send: $('send-btn'),
    count: $('composer-count'),
    newChat: $('new-chat'),
    theme: $('theme-toggle'),
    status: $('sr-status'),
    themeColor: document.querySelector('meta[name="theme-color"]'),
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const state = { messages: [], pending: null };

  class ChatError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
    }
  }

  /* ---------- Sending ---------- */

  function sendMessage(raw) {
    const text = raw.trim();
    if (!text || state.pending) return;
    if (text.length > MAX_INPUT_CHARS) {
      announce(`Messages can be up to ${MAX_INPUT_CHARS} characters.`);
      return;
    }

    state.messages.push({ role: 'user', content: text });
    els.empty.hidden = true;
    const node = renderUserMessage(text);
    els.input.value = '';
    syncComposer();
    scrollToMessage(node, 'end');
    requestReply();
  }

  async function requestReply() {
    clearTransientNotes();
    const job = { controller: new AbortController(), reason: null };
    state.pending = job;
    setBusy(true);

    const loader = renderLoading();
    scrollToMessage(loader, 'end');
    const loaderText = loader.querySelector('[data-loading-text]');
    const slowTimer = setTimeout(() => {
      loaderText.textContent = 'Still thinking…';
    }, SLOW_HINT_MS);
    const timeout = setTimeout(() => {
      job.reason = 'timeout';
      job.controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: recentHistory() }),
        signal: job.controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || typeof data?.reply !== 'string') {
        throw new ChatError(
          data?.error?.message || `The server sent an unexpected response (HTTP ${res.status}).`,
          data?.error?.code,
        );
      }
      if (state.pending !== job) return; // a new chat replaced this request

      state.messages.push({ role: 'assistant', content: data.reply });
      loader.remove();
      const node = renderBotMessage(data.reply, data);
      scrollToMessage(node, 'auto');
    } catch (err) {
      if (state.pending !== job) return;
      loader.remove();
      if (job.reason === 'user') {
        renderError('Stopped. IAM-bot-1 didn’t finish that reply.', { retry: true, muted: true });
      } else if (job.reason === 'timeout') {
        renderError('IAM-bot-1 took too long to answer. Please try again.', { retry: true });
      } else if (err instanceof ChatError) {
        renderError(err.message, {
          retry: !NO_RETRY.has(err.code),
          newChat: err.code === 'context_too_long',
        });
      } else {
        renderError('Couldn’t reach the IAM-bot-1 server. Check your connection and try again.', { retry: true });
      }
    } finally {
      clearTimeout(slowTimer);
      clearTimeout(timeout);
      loader.remove();
      if (state.pending === job) {
        state.pending = null;
        setBusy(false);
      }
    }
  }

  function stopReply() {
    if (!state.pending) return;
    state.pending.reason = 'user';
    state.pending.controller.abort();
  }

  // Newest messages first until the count or character budget runs out.
  function recentHistory() {
    const picked = [];
    let budget = HISTORY_CHAR_BUDGET;
    for (let i = state.messages.length - 1; i >= 0 && picked.length < HISTORY_LIMIT; i--) {
      const { role, content } = state.messages[i];
      if (content.length > budget) break;
      budget -= content.length;
      picked.unshift({ role, content });
    }
    return picked;
  }

  function newChat() {
    if (state.pending) {
      state.pending.reason = 'reset';
      state.pending.controller.abort();
      state.pending = null;
      setBusy(false);
    }
    state.messages = [];
    els.list.replaceChildren();
    els.empty.hidden = false;
    els.scroll.scrollTop = 0;
    announce('Started a new chat.');
    els.input.focus();
  }

  /* ---------- Rendering ---------- */

  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value == null) continue;
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  const icon = (paths) => {
    const span = document.createElement('span');
    span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
    return span.firstElementChild;
  };
  const ICONS = {
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>',
    retry: '<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };

  function botShell(className, labelText, extraMeta) {
    const meta = h('div', { className: 'msg__meta' }, [h('span', { className: 'label label--blue', text: labelText }), extraMeta]);
    const body = h('div', { className: 'msg__body' }, [meta]);
    const li = h('li', { className: `msg msg--bot ${className}` }, [h('span', { className: 'msg__avatar', 'aria-hidden': 'true' }), body]);
    return { li, body };
  }

  function renderUserMessage(text) {
    const li = h('li', { className: 'msg msg--user' }, [
      h('div', { className: 'msg__body' }, [
        h('div', { className: 'msg__meta' }, [h('span', { className: 'label', text: 'You' })]),
        h('div', { className: 'msg__bubble', text }),
      ]),
    ]);
    els.list.append(li);
    return li;
  }

  function renderBotMessage(text, { model, truncated } = {}) {
    const modelLabel = model ? h('span', { className: 'label label--dim', text: model }) : null;
    const { li, body } = botShell('', 'IAM-bot-1', modelLabel);
    body.append(h('div', { className: 'msg__bubble prose', html: renderMarkdown(text) }));
    if (truncated) {
      body.append(h('p', { className: 'msg__note', text: 'This reply hit the length limit. Ask IAM-bot-1 to continue.' }));
    }
    const copy = h('button', { type: 'button', className: 'tool-btn', 'data-action': 'copy', 'aria-label': 'Copy reply' }, [
      icon(ICONS.copy),
      h('span', { text: 'Copy' }),
    ]);
    copy.dataset.copyText = text;
    body.append(h('div', { className: 'msg__tools' }, [copy]));
    els.list.append(li);
    return li;
  }

  function renderLoading() {
    const { li, body } = botShell('msg--loading', 'IAM-bot-1');
    body.append(
      h('div', { className: 'msg__bubble' }, [
        h('span', { className: 'typing', 'aria-hidden': 'true' }, [h('i'), h('i'), h('i')]),
        h('span', { className: 'label', 'data-loading-text': true, text: 'Thinking…' }),
      ]),
    );
    els.list.append(li);
    return li;
  }

  function renderError(message, { retry = false, newChat: offerNewChat = false, muted = false } = {}) {
    const { li, body } = botShell(`msg--error${muted ? ' msg--muted' : ''}`, muted ? 'Stopped' : 'Error');
    li.dataset.transient = 'true';
    body.append(h('div', { className: 'msg__bubble', text: message }));
    const tools = h('div', { className: 'msg__tools' });
    if (retry) {
      tools.append(
        h('button', { type: 'button', className: 'tool-btn tool-btn--primary', 'data-action': 'retry' }, [icon(ICONS.retry), h('span', { text: 'Try again' })]),
      );
    }
    if (offerNewChat) {
      tools.append(
        h('button', { type: 'button', className: 'tool-btn tool-btn--primary', 'data-action': 'new-chat' }, [icon(ICONS.plus), h('span', { text: 'New chat' })]),
      );
    }
    if (tools.childElementCount) body.append(tools);
    els.list.append(li);
    scrollToMessage(li, 'end');
    return li;
  }

  function clearTransientNotes() {
    els.list.querySelectorAll('[data-transient]').forEach((node) => node.remove());
  }

  function scrollToMessage(node, align) {
    const behavior = reducedMotion.matches ? 'auto' : 'smooth';
    let block = align;
    if (align === 'auto') {
      // Long replies: show where they start. Short ones: show the bottom.
      const visible = Math.min(els.scroll.clientHeight, window.innerHeight);
      block = node.offsetHeight > visible * 0.7 ? 'start' : 'end';
    }
    node.scrollIntoView({ block, behavior });
  }

  /* ---------- Safe Markdown (text is escaped before any formatting) ---------- */

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Trailing punctuation (and escaped quotes or brackets) usually ends the sentence,
  // not the address: "see https://example.com." links to https://example.com.
  function splitTrailing(url) {
    let rest = '';
    for (;;) {
      const entity = url.match(/(&quot;|&#39;|&gt;|&lt;)$/);
      if (entity) {
        rest = entity[1] + rest;
        url = url.slice(0, -entity[1].length);
      } else if (/[.,;:!?\]*_~]$/.test(url) || (url.endsWith(')') && !url.includes('('))) {
        rest = url.slice(-1) + rest;
        url = url.slice(0, -1);
      } else {
        return { url, rest };
      }
    }
  }

  function inline(text) {
    return text
      .split(/(`[^`\n]+`)/g)
      .map((part, index) => {
        if (index % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        // Links become placeholders first, so bold/italic never reach inside an href.
        // Only http(s) and mailto addresses are linked, from text that is already escaped.
        const links = [];
        const keep = (url, label) => {
          links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
          return `\u0000${links.length - 1}\u0000`;
        };
        let html = escapeHtml(part)
          .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, label, url) => keep(url, label))
          .replace(/&lt;((?:https?:\/\/|mailto:)\S+?)&gt;/g, (_, url) => keep(url, url.replace(/^mailto:/, '')))
          .replace(/(^|[^\w/="\u0000])(https?:\/\/[^\s<\u0000]+)/g, (_, before, raw) => {
            const { url, rest } = splitTrailing(raw);
            return url.length > 'https://'.length ? `${before}${keep(url, url)}${rest}` : `${before}${raw}`;
          });
        html = html
          .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
          .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
          .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
          .replace(/\n/g, '<br>');
        return html.replace(/\u0000(\d+)\u0000/g, (_, n) => links[Number(n)]);
      })
      .join('');
  }

  const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const TABLE_ROW = /^\s*\|.*\|\s*$/;
  const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

  function renderMarkdown(source) {
    const lines = source.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let paragraph = [];
    let list = null;

    const flushParagraph = () => {
      if (paragraph.length) out.push(`<p>${inline(paragraph.join('\n'))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      const start = list.type === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
      out.push(`<${list.type}${start}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.type}>`);
      list = null;
    };
    const flush = () => {
      flushParagraph();
      flushList();
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
      if (fence) {
        flush();
        const code = [];
        while (i + 1 < lines.length && !/^\s*```\s*$/.test(lines[i + 1])) code.push(lines[++i]);
        i++; // closing fence
        const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : '';
        out.push(`<pre${lang}><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] || '')) {
        flush();
        const head = splitRow(line);
        const rows = [];
        i += 2;
        while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(splitRow(lines[i++]));
        i--;
        out.push(
          `<div class="table-wrap" tabindex="0"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
            `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
        );
        continue;
      }

      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flush();
        const level = Math.min(heading[1].length + 2, 6);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flush();
        out.push('<hr>');
        continue;
      }

      if (/^\s*>/.test(line)) {
        flush();
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        i--;
        out.push(`<blockquote>${inline(quote.join('\n'))}</blockquote>`);
        continue;
      }

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (bullet || ordered) {
        flushParagraph();
        const type = bullet ? 'ul' : 'ol';
        if (!list || list.type !== type) {
          flushList();
          list = { type, items: [], start: ordered ? Number(ordered[1]) : 1 };
        }
        list.items.push(bullet ? bullet[1] : ordered[2]);
        continue;
      }

      if (!line.trim()) {
        flush();
        continue;
      }

      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += `\n${line.trim()}`;
        continue;
      }

      flushList();
      paragraph.push(line);
    }
    flush();
    return out.join('');
  }

  /* ---------- Composer, busy state, theme ---------- */

  function syncComposer() {
    const length = els.input.value.length;
    els.count.textContent = `${length} / ${MAX_INPUT_CHARS}`;
    els.count.classList.toggle('is-near-limit', length > MAX_INPUT_CHARS * 0.9);
    // Grow with the text; an empty box goes back to one line.
    els.input.style.height = 'auto';
    if (length) els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
    if (!state.pending) els.send.disabled = els.input.value.trim().length === 0;
  }

  function setBusy(busy) {
    els.send.classList.toggle('is-busy', busy);
    els.send.setAttribute('aria-label', busy ? 'Stop generating' : 'Send message');
    els.send.title = busy ? 'Stop (Esc)' : 'Send (Enter)';
    els.send.disabled = busy ? false : els.input.value.trim().length === 0;
    els.list.setAttribute('aria-busy', String(busy));
  }

  function announce(message) {
    els.status.textContent = '';
    window.setTimeout(() => {
      els.status.textContent = message;
    }, 50);
  }

  function applyTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;
    const next = theme === 'dark' ? 'light' : 'dark';
    els.theme.setAttribute('aria-label', `Switch to ${next} theme`);
    els.theme.title = `Switch to ${next} theme`;
    els.themeColor?.setAttribute('content', theme === 'dark' ? '#121316' : '#f1f0ea');
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        /* storage unavailable: the choice lasts for this visit only */
      }
    }
  }

  async function copyText(button) {
    const text = button.dataset.copyText || '';
    const label = button.querySelector('span');
    try {
      await navigator.clipboard.writeText(text);
      label.textContent = 'Copied';
      announce('Reply copied to the clipboard.');
    } catch {
      label.textContent = 'Copy failed';
    }
    window.setTimeout(() => {
      label.textContent = 'Copy';
    }, 1600);
  }

  /* ---------- Events ---------- */

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.pending) stopReply();
    else sendMessage(els.input.value);
  });

  els.input.addEventListener('input', syncComposer);
  window.addEventListener('resize', syncComposer);

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!state.pending) sendMessage(els.input.value);
    }
  });

  // Escape stops a reply in progress. Otherwise, inside the site's chat panel,
  // it asks the parent page to close the panel (keys typed here never reach it).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (state.pending) {
      event.preventDefault();
      stopReply();
    } else if (EMBEDDED) {
      window.parent.postMessage({ type: 'iam-bot:close' }, EMBED_PARENT_ORIGIN);
    }
  });

  els.suggestions.addEventListener('click', (event) => {
    const button = event.target.closest('.suggestion');
    if (!button) return;
    sendMessage(button.dataset.prompt || button.textContent);
    els.input.focus();
  });

  els.list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'copy') copyText(button);
    else if (action === 'retry' && !state.pending) {
      els.input.focus();
      requestReply();
    } else if (action === 'new-chat') newChat();
  });

  els.newChat.addEventListener('click', newChat);

  els.theme.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
  });

  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', false);
  syncComposer();
})();

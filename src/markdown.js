// A small, safe Markdown renderer for the library viewer (escapes all HTML first).
(function (root) {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function safeUrl(url) {
    return /^(https?:|mailto:|#)/i.test(url) ? url : null;
  }

  function inline(text) {
    let s = escapeHtml(text);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt) => `<span class="muted">[image: ${alt || 'saved in files folder'}]</span>`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const href = safeUrl(url.replace(/&amp;/g, '&'));
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>` : `${label} <span class="muted">(${url})</span>`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[i]}</code>`);
  }

  function render(md) {
    const lines = String(md || '').split('\n');
    const out = [];
    let i = 0;
    let para = [];
    const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^(`{3,})(.*)$/);
      if (fence) {
        flush();
        const body = [];
        for (i++; i < lines.length && !lines[i].startsWith(fence[1]); i++) body.push(lines[i]);
        out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
        i++;
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^---+\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^>\s?/.test(line)) {
        flush();
        const q = [];
        for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ''));
        out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
        continue;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        flush();
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`);
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (/^\|.*\|\s*$/.test(line)) {
        flush();
        const rows = [];
        for (; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) {
          if (/^\|[\s:|-]+\|\s*$/.test(lines[i])) continue;
          rows.push(`<tr>${lines[i].trim().slice(1, -1).split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('')}</tr>`);
        }
        out.push(`<table>${rows.join('')}</table>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line);
      i++;
    }
    flush();
    return out.join('\n');
  }

  const api = { render, escapeHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatSaverMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

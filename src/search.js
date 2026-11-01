// Full-text search over library records (title, summary, transcript). Every word must match.
(function (root) {
  'use strict';

  function terms(query) {
    return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  function countOf(haystack, term) {
    let n = 0;
    for (let i = haystack.indexOf(term); i !== -1 && n < 50; i = haystack.indexOf(term, i + term.length)) n++;
    return n;
  }

  function snippet(text, term, width) {
    const w = width || 160;
    const plain = String(text || '').replace(/[#*`>|]/g, '').replace(/\s+/g, ' ');
    const at = term ? plain.toLowerCase().indexOf(term) : -1;
    if (at === -1) return plain.slice(0, w);
    const start = Math.max(0, at - Math.floor(w / 3));
    return `${start ? '…' : ''}${plain.slice(start, start + w)}…`;
  }

  // The transcript from the first message on, skipping the title, dates and branch note.
  function chatPart(transcript) {
    const t = String(transcript || '');
    const at = t.search(/^## (You|ChatGPT|Claude)/m);
    return at === -1 ? t : t.slice(at).replace(/^## You\s*/, '');
  }

  // Returns [{ record, score, snippet }], best first. An empty query lists everything newest first.
  function search(records, query, provider) {
    const words = terms(query);
    const out = [];
    for (const r of records) {
      if (provider && r.provider !== provider) continue;
      const title = String(r.title || '').toLowerCase();
      const body = `${r.summary || ''}\n${r.transcript || ''}`.toLowerCase();
      let score = 0;
      let ok = true;
      for (const w of words) {
        const inTitle = countOf(title, w);
        const inBody = countOf(body, w);
        if (!inTitle && !inBody) { ok = false; break; }
        score += inTitle * 10 + inBody;
      }
      if (!ok) continue;
      const firstInBody = words.find((w) => body.includes(w));
      out.push({ record: r, score, snippet: snippet(firstInBody ? r.transcript : (r.summary || chatPart(r.transcript)), firstInBody) });
    }
    out.sort((a, b) => (words.length ? b.score - a.score : 0) || (b.record.updateTime || 0) - (a.record.updateTime || 0));
    return out;
  }

  const api = { search, terms, snippet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatSaverSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

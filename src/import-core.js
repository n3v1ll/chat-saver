// Reads ChatGPT's official "Export data" ZIP (opened with JSZip).
// No network: conversations come from conversations*.json, files from the loose files in the ZIP.
(function (root) {
  'use strict';

  async function readConversations(zip) {
    const names = Object.keys(zip.files)
      .filter((n) => /(^|\/)conversations(-\d+)?\.json$/.test(n))
      .sort();
    if (!names.length) throw new Error('This ZIP has no conversations.json. Is it the ChatGPT data export?');
    const all = [];
    for (const name of names) {
      const data = JSON.parse(await zip.file(name).async('string'));
      for (const conv of Array.isArray(data) ? data : [data]) {
        conv.conversation_id = conv.conversation_id || conv.id;
        all.push(conv);
      }
    }
    all.sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    return all;
  }

  // Export files are named "<file id>-<original name>" or "<file id>.<ext>",
  // sometimes inside folders such as dalle-generations/ or user-xxxx/.
  function fileLookup(zip) {
    const byId = new Map();
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const base = path.split('/').pop();
      const m = base.match(/^(file[-_][A-Za-z0-9]+)(?:-(.+)|(\.[A-Za-z0-9]+))?$/);
      if (m && !byId.has(m[1])) byId.set(m[1], { path, name: m[2] || (m[3] ? base : null) });
    }
    return async function downloadFile(ref) {
      if (ref.kind === 'sandbox') throw new Error("not included in ChatGPT's data export");
      const hit = byId.get(ref.id);
      if (!hit) throw new Error("not included in ChatGPT's data export");
      const bytes = await zip.file(hit.path).async('uint8array');
      return { bytes, name: hit.name };
    };
  }

  const api = { readConversations, fileLookup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatSaverImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

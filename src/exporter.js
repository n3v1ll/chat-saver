// Turns one conversation into a folder inside a JSZip archive.
// All network access goes through `deps`, so tests can run it in Node with fakes.
(function (root) {
  'use strict';

  const C = typeof module !== 'undefined' && module.exports ? require('./convert.js') : root.ChatSaver;

  const EXT_BY_MIME = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json', 'text/markdown': 'md',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  };

  const CANVAS_EXT = { document: 'md', 'code/python': 'py', 'code/javascript': 'js', 'code/typescript': 'ts', 'code/html': 'html', 'code/react': 'jsx', 'code/java': 'java', 'code/cpp': 'cpp', 'code/go': 'go', 'code/rust': 'rs', 'code/sql': 'sql', 'code/bash': 'sh', 'code/svg': 'svg', 'code/mermaid': 'mmd', 'code/markdown': 'md', 'code/text': 'txt', 'code/css': 'css', 'code/json': 'json' };

  function extFor(contentType) {
    const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
    return EXT_BY_MIME[mime] || 'bin';
  }

  // Servers often send files as application/octet-stream, so recognise common types by their first bytes.
  function sniffMime(bytes) {
    const b = bytes || [];
    const at = (i, ...xs) => xs.every((x, j) => b[i + j] === x);
    if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
    if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
    if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
    if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
    return null;
  }

  function bestMime(got, ref) {
    const sent = String(got.contentType || '').split(';')[0].trim().toLowerCase();
    if (sent && sent !== 'application/octet-stream' && EXT_BY_MIME[sent]) return sent;
    return sniffMime(got.bytes) || ref.mime || sent;
  }

  function uniquePath(used, folder, name) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = `files/${folder}/${name}`;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `files/${folder}/${base} (${i})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * deps: {
   *   JSZip,
   *   downloadFile(ref) -> { bytes: Uint8Array, name?, contentType? }   // ref from collectFiles / collectSandboxFiles
   *   fetchTextdocs?() -> [{ title, textdoc_type, content }]
   *   summarize?(title, transcript) -> { summary, continueBrief } | { skipped: true }
   *   onProgress?(text)
   * }
   * Returns { zip, folder, report }.
   */
  async function exportConversation(conv, deps) {
    const progress = deps.onProgress || (() => {});
    // In bulk mode several chats share one zip; deps.usedFolders keeps their folder names unique.
    const zip = deps.zip || new deps.JSZip();
    let folder = deps.folder || C.folderName(conv);
    if (deps.usedFolders && !deps.folder) {
      for (let i = 2; deps.usedFolders.has(folder); i++) folder = `${C.folderName(conv)}-${i}`;
      deps.usedFolders.add(folder);
    }
    const dir = zip.folder(folder);
    const used = new Set();
    const fileIndex = new Map();
    const saved = [];
    const failed = [];

    // Auto-backup passes the files saved on earlier runs; those are linked, not downloaded again.
    const existing = deps.existingFiles || {};
    for (const p of Object.values(existing)) used.add(p.toLowerCase());
    const written = [];
    const refs = [...C.collectFiles(conv), ...C.collectSandboxFiles(conv)];
    let done = 0;
    await mapLimit(refs, 3, async (ref) => {
      const key = ref.id || ref.sandboxPath;
      if (existing[key]) {
        fileIndex.set(key, existing[key]);
        saved.push({ fileName: existing[key].split('/').pop(), path: existing[key], folder: ref.folder, kind: ref.kind });
        progress(`Saving files ${++done}/${refs.length}`);
        return;
      }
      try {
        const got = await deps.downloadFile(ref);
        const rawName = ref.name || got.name || `${ref.id || 'file'}.${extFor(bestMime(got, ref))}`;
        const path = uniquePath(used, ref.folder, C.safeName(rawName, ref.id || 'file'));
        dir.file(path, got.bytes, { binary: true });
        written.push(path);
        fileIndex.set(key, path);
        saved.push({ fileName: path.split('/').pop(), path, folder: ref.folder, kind: ref.kind });
      } catch (err) {
        const expired = ref.kind === 'sandbox';
        failed.push({ ...ref, error: expired ? `code sandbox file expired (${err.message || err})` : String(err.message || err) });
      }
      progress(`Saving files ${++done}/${refs.length}`);
    });

    // Canvas documents: prefer the latest versions from the server, fall back to what the chat contains.
    let canvases = [];
    if (deps.fetchTextdocs) {
      try {
        canvases = (await deps.fetchTextdocs()) || [];
      } catch (e) {
        canvases = [];
      }
    }
    if (!canvases.length) canvases = C.collectCanvasFromMessages(conv).map((d) => ({ title: d.title, textdoc_type: d.type, content: d.content }));
    for (const doc of canvases) {
      const ext = CANVAS_EXT[doc.textdoc_type] || (String(doc.textdoc_type || '').startsWith('code/') ? 'txt' : 'md');
      const path = uniquePath(used, 'canvas', C.safeName(`${doc.title || 'canvas'}.${ext}`, 'canvas'));
      dir.file(path, doc.content || '');
      written.push(path);
      saved.push({ fileName: path.split('/').pop(), path, folder: 'canvas', kind: 'canvas' });
    }

    const links = C.collectLinks(conv);

    let summary = null;
    let continueBrief = null;
    let summaryError = null;
    if (deps.summarize) {
      progress('Writing AI summary');
      try {
        const res = await deps.summarize(conv.title, C.toPlainText(conv, 120000));
        if (res && !res.skipped) {
          summary = res.summary;
          continueBrief = res.continueBrief;
        }
      } catch (err) {
        summaryError = String(err.message || err);
      }
    }

    progress('Building ZIP');
    const transcript = C.toMarkdown(conv, fileIndex, { summary });
    dir.file('README.md', C.readmeMarkdown(conv, saved, failed, links, summary));
    dir.file('transcript.md', transcript);
    dir.file('conversation.json', JSON.stringify(conv, null, 2));
    dir.file('links.md', C.linksMarkdown(links));
    const continueText = continueBrief || C.continueFallback(conv);
    dir.file('continue.md', continueText);

    const report = {
      title: conv.title,
      conversationId: conv.conversation_id || conv.id,
      folder,
      created: C.isoDate(conv.create_time),
      updated: C.isoDate(conv.update_time),
      model: conv.default_model_slug || null,
      exportedAt: new Date().toISOString(),
      filesSaved: saved.length,
      filesFailed: failed.map((f) => ({ name: f.name || f.sandboxPath || f.id, error: f.error })),
      aiSummary: summary ? 'included' : summaryError ? `failed: ${summaryError}` : 'not configured',
    };
    dir.file('export-report.json', JSON.stringify(report, null, 2));
    written.push('README.md', 'transcript.md', 'conversation.json', 'links.md', 'continue.md', 'export-report.json');
    return { zip, folder, report, written, files: Object.fromEntries(fileIndex), transcript, summary, continueText };
  }

  // Top-level index for a ZIP holding many chats. Rows: reports from exportConversation, or { title, error }.
  function indexMarkdown(reports) {
    const ok = reports.filter((r) => !r.error);
    const bad = reports.filter((r) => r.error);
    const cell = (t) => String(t || 'Untitled').replace(/\|/g, '\\|').replace(/[[\]]/g, '');
    const lines = ['# Saved ChatGPT chats', '', `${ok.length} chat(s) saved on ${new Date().toISOString().slice(0, 10)}.`, ''];
    if (ok.length) {
      lines.push('| Chat | Started | Last updated | Files | AI summary |', '| --- | --- | --- | --- | --- |');
      const sorted = [...ok].sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
      for (const r of sorted) {
        lines.push(`| [${cell(r.title)}](${encodeURI(r.folder)}/README.md) | ${r.created || ''} | ${r.updated || ''} | ${r.filesSaved}${r.filesFailed.length ? ` (${r.filesFailed.length} missing)` : ''} | ${r.aiSummary === 'included' ? 'yes' : 'no'} |`);
      }
      lines.push('');
    }
    if (bad.length) {
      lines.push('## Chats that could not be saved', '');
      for (const r of bad) lines.push(`- ${cell(r.title)}: ${r.error}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  const api = { exportConversation, extFor, sniffMime, indexMarkdown };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatSaver = Object.assign(root.ChatSaver || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

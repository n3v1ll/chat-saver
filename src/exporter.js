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

  const CANVAS_EXT = { document: 'md', 'code/python': 'py', 'code/javascript': 'js', 'code/typescript': 'ts', 'code/html': 'html', 'code/react': 'jsx', 'code/java': 'java', 'code/cpp': 'cpp', 'code/go': 'go', 'code/rust': 'rs', 'code/sql': 'sql', 'code/bash': 'sh' };

  function extFor(contentType) {
    const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
    return EXT_BY_MIME[mime] || 'bin';
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
    const zip = new deps.JSZip();
    const folder = C.folderName(conv);
    const dir = zip.folder(folder);
    const used = new Set();
    const fileIndex = new Map();
    const saved = [];
    const failed = [];

    const refs = [...C.collectFiles(conv), ...C.collectSandboxFiles(conv)];
    let done = 0;
    await mapLimit(refs, 3, async (ref) => {
      try {
        const got = await deps.downloadFile(ref);
        const rawName = ref.name || got.name || `${ref.id || 'file'}.${extFor(got.contentType || ref.mime)}`;
        const path = uniquePath(used, ref.folder, C.safeName(rawName, ref.id || 'file'));
        dir.file(path, got.bytes, { binary: true });
        fileIndex.set(ref.id || ref.sandboxPath, path);
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
    dir.file('README.md', C.readmeMarkdown(conv, saved, failed, links, summary));
    dir.file('transcript.md', C.toMarkdown(conv, fileIndex, { summary }));
    dir.file('conversation.json', JSON.stringify(conv, null, 2));
    dir.file('links.md', C.linksMarkdown(links));
    dir.file('continue.md', continueBrief || C.continueFallback(conv));

    const report = {
      title: conv.title,
      conversationId: conv.conversation_id || conv.id,
      exportedAt: new Date().toISOString(),
      filesSaved: saved.length,
      filesFailed: failed.map((f) => ({ name: f.name || f.sandboxPath || f.id, error: f.error })),
      aiSummary: summary ? 'included' : summaryError ? `failed: ${summaryError}` : 'not configured',
    };
    dir.file('export-report.json', JSON.stringify(report, null, 2));
    return { zip, folder, report };
  }

  const api = { exportConversation, extFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatSaver = Object.assign(root.ChatSaver || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

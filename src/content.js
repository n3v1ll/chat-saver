// Runs on supported chat sites: the "Save chat" button, bulk saves from the popup, auto-backup, and the self-test.
// Site-specific API calls live in src/providers/*.js, which set globalThis.ChatSaverProvider.
(function () {
  'use strict';

  const CS = globalThis.ChatSaver;
  const P = globalThis.ChatSaverProvider;
  const { sendToBackground } = globalThis.ChatSaverRuntime;
  if (!P) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const VERSION = chrome.runtime.getManifest().version;

  // Retry on rate limiting with growing waits, so bulk saves never hammer the site.
  async function withBackoff(fn, setStatus) {
    for (let wait = 10000; ; wait *= 2) {
      try {
        return await fn();
      } catch (err) {
        if (!/ 429 /.test(String(err.message)) || wait > 80000) throw err;
        setStatus(`${P.label} asked us to slow down, waiting ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }

  async function exportOne(convId, opts) {
    const conv = await P.getConversation(convId);
    const result = await CS.exportConversation(conv, {
      JSZip,
      zip: opts.zip,
      usedFolders: opts.usedFolders,
      folder: opts.folderFor ? opts.folderFor(conv) : undefined,
      existingFiles: opts.existingFiles,
      downloadFile: (ref) => P.downloadFile(convId, ref),
      fetchTextdocs: () => P.fetchTextdocs(convId),
      summarize: opts.withSummary === false ? null : (title, transcript) => sendToBackground({ type: 'summarize', title, transcript }),
      onProgress: opts.onProgress,
    });
    return { ...result, conv };
  }

  async function downloadZip(zip, name) {
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function saveCurrentChat(setStatus) {
    const convId = P.conversationIdFromUrl();
    if (!convId) throw new Error('Open a chat first.');
    setStatus('Reading chat');
    const { zip, folder, report } = await exportOne(convId, { onProgress: setStatus });
    await downloadZip(zip, `${folder}.zip`);
    return report;
  }

  // Several chats into one ZIP with an index.md at the top.
  async function saveManyChats(items, withSummary, setStatus) {
    const zip = new JSZip();
    const usedFolders = new Set();
    const reports = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const prefix = `Chat ${i + 1}/${items.length}`;
      setStatus(prefix);
      try {
        const { report } = await withBackoff(() => exportOne(item.id, {
          zip, usedFolders, withSummary, onProgress: (t) => setStatus(`${prefix}: ${t}`),
        }), setStatus);
        reports.push(report);
      } catch (err) {
        reports.push({ title: item.title, error: String(err.message || err) });
      }
      if (i < items.length - 1) await sleep(1500); // pace requests like a person clicking through
    }
    zip.file('index.md', CS.indexMarkdown(reports));
    zip.file('index.json', JSON.stringify(reports, null, 2));
    setStatus('Building ZIP');
    await downloadZip(zip, `${P.id}-chats_${new Date().toISOString().slice(0, 10)}.zip`);
    return reports;
  }

  // ---- Auto-backup ----
  // Walks the chat list newest first and backs up chats that changed since the last run.
  // Files saved before are not downloaded again.

  const MIME = { md: 'text/markdown', json: 'application/json', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', csv: 'text/csv', html: 'text/html', svg: 'image/svg+xml' };
  const mimeFor = (path) => MIME[(path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const tabToken = Math.random().toString(36).slice(2);
  const MAX_PER_TICK = 25;
  const ACTIVE_GRACE_S = 120; // leave chats that are still being written in alone for a couple of minutes
  let busy = false;

  async function backupOne(item, prev, withSummary) {
    // The folder name is fixed on the first backup (date, title, short id) so later renames don't duplicate it.
    const folderFor = (conv) => (prev && prev.folder) || `${CS.folderName(conv)}_${String(item.id).slice(0, 8)}`;
    const res = await exportOne(item.id, { folderFor, existingFiles: prev && prev.files, withSummary });
    let readmeDownloadId = null;
    for (const path of res.written) {
      const base64 = await res.zip.file(`${res.folder}/${path}`).async('base64');
      const id = await sendToBackground({ type: 'backupFile', provider: P.id, folder: res.folder, path, base64, mime: mimeFor(path) });
      if (path === 'README.md') readmeDownloadId = id;
    }
    await sendToBackground({
      type: 'backupRecord',
      record: {
        key: `${P.id}:${item.id}`,
        provider: P.id,
        id: item.id,
        title: res.conv.title || item.title,
        created: CS.isoDate(res.conv.create_time),
        updated: CS.isoDate(item.updateTime),
        updateTime: item.updateTime,
        folder: res.folder,
        url: CS.chatUrl(res.conv),
        files: res.files,
        filesSaved: res.report.filesSaved,
        filesFailed: res.report.filesFailed.length,
        transcript: res.transcript,
        summary: res.summary || (prev && prev.summary) || null,
        readmeDownloadId,
        backedUpAt: Date.now(),
      },
    });
  }

  async function backupTick(force) {
    const settings = await chrome.storage.local.get(['autoBackup', 'backupSummaries']);
    if ((!settings.autoBackup && !force) || busy) return { skipped: true };
    if (!(await sendToBackground({ type: 'backupLock', owner: tabToken }))) return { skipped: true };
    busy = true;
    let done = 0;
    let more = false;
    try {
      const state = await sendToBackground({ type: 'backupState', provider: P.id });
      const now = Date.now() / 1000;
      const queue = [];
      for (let offset = 0; queue.length < MAX_PER_TICK; ) {
        const page = await P.listConversations(offset);
        let changed = 0;
        for (const item of page.items) {
          const prev = state[item.id];
          if (prev && prev.updateTime >= item.updateTime) continue;
          changed++;
          if (now - item.updateTime < ACTIVE_GRACE_S) continue;
          if (queue.length < MAX_PER_TICK) queue.push(item);
          else more = true;
        }
        // The list is newest first, so a page with no changes means everything older is backed up too.
        if (!changed || !page.hasMore) break;
        offset += page.items.length;
        await sleep(1000);
      }
      for (const item of queue) {
        try {
          await withBackoff(() => backupOne(item, state[item.id], !!settings.backupSummaries), () => {});
          done++;
        } catch (err) {
          await sendToBackground({ type: 'backupError', error: `${item.title}: ${err.message || err}` });
        }
        await sleep(2000);
      }
      if (queue.length >= MAX_PER_TICK) more = true;
    } catch (err) {
      await sendToBackground({ type: 'backupError', error: String(err.message || err) }).catch(() => {});
      throw err;
    } finally {
      busy = false;
      await sendToBackground({ type: 'backupUnlock', owner: tabToken }).catch(() => {});
    }
    if (more) setTimeout(() => backupTick(force).catch(() => {}), 30000); // keep working through a big first backup
    return { done, more };
  }

  // ---- Self-test ----

  async function selfTest() {
    let sampleId = P.conversationIdFromUrl();
    const results = [];
    if (!sampleId) {
      try {
        sampleId = (await P.listConversations(0)).items[0].id;
      } catch (e) { /* reported by the list test */ }
    }
    for (const [name, fn] of P.selfTests(sampleId)) {
      const started = Date.now();
      try {
        results.push({ name, ok: true, detail: await fn(), ms: Date.now() - started });
      } catch (err) {
        results.push({ name, ok: false, detail: String(err.message || err), ms: Date.now() - started });
      }
    }
    return { app: P.label, extensionVersion: VERSION, browser: navigator.userAgent, ranAt: new Date().toISOString(), results };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const reply = (promise) => {
      promise.then((r) => sendResponse({ ok: true, result: r }), (e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    };
    switch (msg.type) {
      case 'whoami': sendResponse({ ok: true, result: { id: P.id, label: P.label } }); return false;
      case 'listConversations': return reply(P.listConversations(msg.offset));
      case 'selfTest': return reply(selfTest());
      case 'backupTick': return reply(backupTick(!!msg.force));
      case 'saveMany':
        if (busy) {
          sendResponse({ ok: false, error: 'A save is already running in this tab.' });
          return false;
        }
        busy = true;
        sendResponse({ ok: true }); // the popup may close; progress shows in the page
        saveManyChats(msg.items, msg.withSummary, (t) => toast(`<b>Chat Saver</b><br>${escapeHtml(t)}`))
          .then((reports) => {
            const failed = reports.filter((r) => r.error).length;
            toast(`<b>Saved ${reports.length - failed} chat(s).</b>${failed ? ` ${failed} failed, see index.md.` : ''}`, 15000);
          }, (err) => toast(`<b>Bulk save failed.</b><br>${escapeHtml(err.message || err)}`, 15000))
          .finally(() => { busy = false; });
        return false;
      default:
        return false;
    }
  });

  // ---- UI ----
  const style = document.createElement('style');
  style.textContent = `
    #chat-saver-btn { position: fixed; right: 20px; bottom: 96px; z-index: 2147483000; display: flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 999px; border: 1px solid rgba(0,0,0,.15); background: ${P.color}; color: #fff;
      font: 600 13px/1.2 system-ui, sans-serif; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
    #chat-saver-btn[disabled] { opacity: .85; cursor: progress; }
    #chat-saver-toast { position: fixed; right: 20px; bottom: 140px; z-index: 2147483000; max-width: 320px; padding: 10px 12px;
      border-radius: 10px; background: #202123; color: #fff; font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
    #chat-saver-toast a { color: #7fe0c4; }
  `;
  document.documentElement.appendChild(style);

  function toast(html, ms) {
    let el = document.getElementById('chat-saver-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chat-saver-toast';
      document.body.appendChild(el);
    }
    el.innerHTML = html;
    clearTimeout(el._timer);
    if (ms) el._timer = setTimeout(() => el.remove(), ms);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ensureButton() {
    let btn = document.getElementById('chat-saver-btn');
    const onChat = !!P.conversationIdFromUrl();
    if (!onChat) {
      if (btn) btn.remove();
      return;
    }
    if (btn) return;
    btn = document.createElement('button');
    btn.id = 'chat-saver-btn';
    btn.type = 'button';
    btn.textContent = '⬇ Save chat';
    btn.title = 'Save this chat with its files (Chat Saver)';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const setStatus = (t) => { btn.textContent = `⏳ ${t}`; };
      try {
        const report = await saveCurrentChat(setStatus);
        const notes = [];
        notes.push(`${report.filesSaved} file(s) saved`);
        if (report.filesFailed.length) notes.push(`${report.filesFailed.length} could not be saved (see README)`);
        if (report.aiSummary === 'not configured') notes.push('no AI summary: <a href="#" id="chat-saver-opts">add your API key</a>');
        else if (report.aiSummary.startsWith('failed')) notes.push(`AI summary ${escapeHtml(report.aiSummary)}`);
        toast(`<b>Saved.</b> ${notes.join(' · ')}`, 12000);
        const link = document.getElementById('chat-saver-opts');
        if (link) link.addEventListener('click', (e) => { e.preventDefault(); sendToBackground({ type: 'openOptions' }); });
      } catch (err) {
        toast(`<b>Could not save this chat.</b><br>${escapeHtml(err.message || err)}`, 15000);
      } finally {
        btn.disabled = false;
        btn.textContent = '⬇ Save chat';
      }
    });
    document.body.appendChild(btn);
  }

  // Chat sites are single-page apps, so watch for navigation between chats.
  ensureButton();
  setInterval(ensureButton, 1000);

  // Auto-backup: shortly after the page loads, then every few minutes (the background alarm also nudges us).
  setTimeout(() => backupTick(false).catch(() => {}), 15000);
  setInterval(() => backupTick(false).catch(() => {}), 5 * 60 * 1000);
})();

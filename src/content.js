// Runs on chatgpt.com: adds the "Save chat" button and talks to ChatGPT's web API from the user's own tab.
(function () {
  'use strict';

  const CS = globalThis.ChatSaver;

  function conversationIdFromUrl() {
    const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  let cachedToken = null;
  async function authHeaders() {
    if (!cachedToken) {
      const res = await fetch('/api/auth/session', { credentials: 'include' });
      if (!res.ok) throw new Error('Could not read your ChatGPT session. Are you logged in?');
      const session = await res.json();
      cachedToken = session.accessToken;
      if (!cachedToken) throw new Error('No ChatGPT session found. Please log in and try again.');
    }
    const headers = { Authorization: `Bearer ${cachedToken}` };
    const account = getCookie('_account');
    if (account) headers['ChatGPT-Account-Id'] = account; // Team / workspace accounts
    return headers;
  }

  async function api(path) {
    const res = await fetch(path, { credentials: 'include', headers: await authHeaders() });
    if (res.status === 401) cachedToken = null;
    if (!res.ok) throw new Error(`ChatGPT returned ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (reply) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!reply || !reply.ok) return reject(new Error((reply && reply.error) || 'No reply from extension'));
        resolve(reply.result);
      });
    });
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function fetchBytes(url) {
    const absolute = new URL(url, location.origin);
    if (absolute.origin === location.origin) {
      const res = await fetch(absolute, { credentials: 'include', headers: await authHeaders() });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
    }
    // Signed links on other hosts are fetched by the background worker to avoid CORS.
    const got = await sendToBackground({ type: 'fetchBinary', url: absolute.href });
    return { bytes: base64ToBytes(got.base64), contentType: got.contentType };
  }

  // Signed download links expire within minutes, so each one is requested right before it is used.
  async function downloadFile(convId, ref) {
    let info;
    if (ref.kind === 'sandbox') {
      info = await api(`/backend-api/conversation/${convId}/interpreter/download?message_id=${encodeURIComponent(ref.messageId)}&sandbox_path=${encodeURIComponent(ref.sandboxPath)}`);
    } else {
      try {
        info = await api(`/backend-api/files/download/${encodeURIComponent(ref.id)}?conversation_id=${convId}&inline=false`);
      } catch (e) {
        info = await api(`/backend-api/files/${encodeURIComponent(ref.id)}/download`);
      }
    }
    if (!info || !info.download_url) throw new Error((info && (info.error_message || info.error_code)) || 'no download link (file may have expired)');
    const got = await fetchBytes(info.download_url);
    return { ...got, name: info.file_name || null };
  }

  async function fetchTextdocs(convId) {
    const docs = await api(`/backend-api/conversation/${convId}/textdocs`);
    return (Array.isArray(docs) ? docs : []).map((d) => ({ title: d.title, textdoc_type: d.textdoc_type, content: d.content }));
  }

  async function saveCurrentChat(setStatus) {
    const convId = conversationIdFromUrl();
    if (!convId) throw new Error('Open a chat first.');
    setStatus('Reading chat');
    const conv = await api(`/backend-api/conversation/${convId}`);
    conv.conversation_id = conv.conversation_id || convId;

    const { zip, folder, report } = await CS.exportConversation(conv, {
      JSZip,
      downloadFile: (ref) => downloadFile(convId, ref),
      fetchTextdocs: () => fetchTextdocs(convId),
      summarize: (title, transcript) => sendToBackground({ type: 'summarize', title, transcript }),
      onProgress: setStatus,
    });

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${folder}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return report;
  }

  // ---- UI ----
  const style = document.createElement('style');
  style.textContent = `
    #chat-saver-btn { position: fixed; right: 20px; bottom: 96px; z-index: 2147483000; display: flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 999px; border: 1px solid rgba(0,0,0,.15); background: #10a37f; color: #fff;
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
    const onChat = !!conversationIdFromUrl();
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

  // ChatGPT is a single-page app, so watch for navigation between chats.
  ensureButton();
  setInterval(ensureButton, 1000);
})();

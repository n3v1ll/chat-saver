// ChatGPT (chatgpt.com): reads chats through the same internal endpoints the web app uses.
(function (root) {
  'use strict';

  if (!/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname)) return;
  const { fetchBytes } = root.ChatSaverRuntime;

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

  function toEpoch(t) {
    if (typeof t === 'number') return t;
    const ms = Date.parse(t);
    return isNaN(ms) ? 0 : ms / 1000;
  }

  root.ChatSaverProvider = {
    id: 'chatgpt',
    label: 'ChatGPT',
    composerSelector: '#prompt-textarea, textarea[name="prompt-textarea"]',
    color: '#10a37f',

    conversationIdFromUrl() {
      const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
      return m ? m[1] : null;
    },

    // Newest first. updateTime is seconds since epoch, used by auto-backup to spot changes.
    async listConversations(offset) {
      const page = await api(`/backend-api/conversations?offset=${offset || 0}&limit=50&order=updated`);
      const items = (page.items || []).map((c) => ({ id: c.id, title: c.title, updateTime: toEpoch(c.update_time) }));
      return { items, total: page.total, hasMore: (offset || 0) + items.length < (page.total || 0) };
    },

    async getConversation(id) {
      const conv = await api(`/backend-api/conversation/${id}`);
      conv.conversation_id = conv.conversation_id || id;
      conv.provider = 'chatgpt';
      conv.chat_url = `https://chatgpt.com/c/${conv.conversation_id}`;
      return conv;
    },

    // Signed download links expire within minutes, so each one is requested right before it is used.
    async downloadFile(convId, ref) {
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
      const got = await fetchBytes(info.download_url, await authHeaders());
      return { ...got, name: info.file_name || null };
    },

    async fetchTextdocs(convId) {
      const docs = await api(`/backend-api/conversation/${convId}/textdocs`);
      return (Array.isArray(docs) ? docs : []).map((d) => ({ title: d.title, textdoc_type: d.textdoc_type, content: d.content }));
    },

    // Checks used by "Run self-test". Each returns a short detail string or throws.
    selfTests(sampleId) {
      return [
        ['Logged in', async () => { await authHeaders(); return 'session found'; }],
        ['List chats', async () => { const p = await this.listConversations(0); return `${p.items.length} on first page, ${p.total} total`; }],
        ['Read a chat', async () => {
          const conv = await this.getConversation(sampleId);
          const types = new Set(Object.values(conv.mapping || {}).map((n) => n.message && n.message.content && n.message.content.content_type).filter(Boolean));
          return `${Object.keys(conv.mapping || {}).length} nodes; content types: ${[...types].join(', ')}`;
        }],
        ['Canvas endpoint', async () => { const d = await this.fetchTextdocs(sampleId); return `${d.length} canvas doc(s)`; }],
        ['File download', async () => {
          const conv = await this.getConversation(sampleId);
          const ref = root.ChatSaver.collectFiles(conv)[0];
          if (!ref) return 'skipped: this chat has no files (open a chat with an upload and run again)';
          const got = await this.downloadFile(sampleId, ref);
          return `ok, ${got.bytes.length} bytes, ${got.contentType || 'unknown type'}`;
        }],
      ];
    },
  };
})(globalThis);

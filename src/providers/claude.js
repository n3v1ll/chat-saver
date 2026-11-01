// Claude (claude.ai): reads chats through the web app's own endpoints, using the page's login cookies.
(function (root) {
  'use strict';

  if (!/(^|\.)claude\.ai$/.test(location.hostname)) return;
  const { fetchBytes } = root.ChatSaverRuntime;
  const { claudeToConversation } = root.ChatSaverClaude;

  async function api(path) {
    const res = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Claude returned ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  }

  let orgId = null;
  async function org() {
    if (orgId) return orgId;
    const m = document.cookie.match(/(?:^|; )lastActiveOrg=([^;]*)/);
    if (m) return (orgId = decodeURIComponent(m[1]));
    const orgs = await api('/api/organizations');
    const chatOrg = (orgs || []).find((o) => (o.capabilities || []).includes('chat')) || (orgs || [])[0];
    if (!chatOrg) throw new Error('Could not find your Claude account. Are you logged in?');
    return (orgId = chatOrg.uuid);
  }

  // Each conversation is converted once and kept briefly so file downloads can find their URLs.
  const cache = new Map();

  root.ChatSaverProvider = {
    id: 'claude',
    label: 'Claude',
    color: '#c96442',

    conversationIdFromUrl() {
      const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
      return m ? m[1] : null;
    },

    async listConversations(offset) {
      const limit = 50;
      const list = await api(`/api/organizations/${await org()}/chat_conversations?limit=${limit}&offset=${offset || 0}`);
      const items = (Array.isArray(list) ? list : list.data || []).map((c) => ({ id: c.uuid, title: c.name || 'Untitled', updateTime: Date.parse(c.updated_at) / 1000 || 0 }));
      items.sort((a, b) => b.updateTime - a.updateTime);
      return { items, total: null, hasMore: items.length === limit };
    },

    async getConversation(id) {
      const raw = await api(`/api/organizations/${await org()}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`);
      const converted = claudeToConversation(raw);
      cache.set(id, converted);
      if (cache.size > 5) cache.delete(cache.keys().next().value);
      return converted.conv;
    },

    async downloadFile(convId, ref) {
      const converted = cache.get(convId) || claudeToConversation(await api(`/api/organizations/${await org()}/chat_conversations/${convId}?tree=True&rendering_mode=messages`));
      const info = converted.files[ref.id];
      if (!info) throw new Error('file not found in chat');
      if (info.text != null) return { bytes: new TextEncoder().encode(info.text), contentType: 'text/plain', name: info.name };
      if (!info.url) throw new Error('Claude did not provide a download link for this file');
      const got = await fetchBytes(info.url);
      return { ...got, name: info.name };
    },

    async fetchTextdocs(convId) {
      const converted = cache.get(convId);
      return converted ? converted.artifacts : [];
    },

    selfTests(sampleId) {
      return [
        ['Logged in', async () => `account ${String(await org()).slice(0, 8)}…`],
        ['List chats', async () => { const p = await this.listConversations(0); return `${p.items.length} on first page`; }],
        ['Read a chat', async () => {
          const conv = await this.getConversation(sampleId);
          const n = Object.keys(conv.mapping).length - 1;
          const a = (await this.fetchTextdocs(sampleId)).length;
          return `${n} messages, ${a} artifact(s)`;
        }],
        ['File download', async () => {
          await this.getConversation(sampleId);
          const ref = Object.keys(cache.get(sampleId).files)[0];
          if (!ref) return 'skipped: this chat has no files (open a chat with an upload and run again)';
          const got = await this.downloadFile(sampleId, { id: ref });
          return `ok, ${got.bytes.length} bytes, ${got.contentType || 'unknown type'}`;
        }],
      ];
    },
  };
})(globalThis);

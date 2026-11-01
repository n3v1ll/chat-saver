// Converts a claude.ai conversation into the ChatGPT-style shape convert.js and exporter.js understand.
(function (root) {
  'use strict';

  const ROOT_ID = 'claude-root';

  function epoch(t) {
    const ms = Date.parse(t);
    return isNaN(ms) ? null : ms / 1000;
  }

  function fileUrl(f) {
    const asset = f.document_asset || f.preview_asset || f.thumbnail_asset;
    return (asset && asset.url) || f.preview_url || f.thumbnail_url || null;
  }

  const ARTIFACT_TYPES = {
    'text/markdown': 'document',
    'text/html': 'code/html',
    'application/vnd.ant.react': 'code/react',
    'image/svg+xml': 'code/svg',
    'application/vnd.ant.mermaid': 'code/mermaid',
  };

  function artifactType(input) {
    if (input.type === 'application/vnd.ant.code') return `code/${(input.language || 'text').toLowerCase()}`;
    return ARTIFACT_TYPES[input.type] || 'document';
  }

  // Returns { conv, files, artifacts }:
  //   files: { [id]: { url?, text?, name, mime } } so the provider can download each reference,
  //   artifacts: final version of each artifact on the current branch, as canvas-style docs.
  function claudeToConversation(raw) {
    const msgs = raw.chat_messages || [];
    const byId = new Map(msgs.map((m) => [m.uuid, m]));
    const files = {};
    const mapping = { [ROOT_ID]: { id: ROOT_ID, message: null, parent: null, children: [] } };

    for (const m of msgs) {
      const parts = [];
      const attachments = [];
      const citations = [];
      for (const f of m.files_v2 || m.files || []) {
        const id = f.file_uuid || f.uuid;
        if (!id) continue;
        files[id] = { url: fileUrl(f), name: f.file_name, mime: f.file_kind === 'image' ? 'image/png' : undefined };
        if (f.file_kind === 'image') parts.push({ content_type: 'image_asset_pointer', asset_pointer: `claude-file://${id}` });
        else attachments.push({ id, name: f.file_name });
      }
      (m.attachments || []).forEach((a, i) => {
        const id = `attachment-${m.uuid}-${i}`;
        files[id] = { text: a.extracted_content || '', name: a.file_name || `pasted-text-${i + 1}.txt`, mime: 'text/plain' };
        attachments.push({ id, name: files[id].name, mime_type: 'text/plain' });
      });

      const blocks = Array.isArray(m.content) && m.content.length ? m.content : [{ type: 'text', text: m.text || '' }];
      for (const b of blocks) {
        if (b.type === 'text') {
          if (b.text) parts.push(b.text);
          for (const c of b.citations || []) if (c.url) citations.push({ metadata: { url: c.url, title: c.title || c.url } });
        } else if (b.type === 'tool_use') {
          const input = b.input || {};
          if (b.name === 'artifacts') parts.push(`*[Artifact: ${input.title || input.id || 'untitled'}, saved in files/canvas]*`);
          else parts.push(`*[Used ${b.name}${input.query ? `: "${input.query}"` : ''}]*`);
        } else if (b.type === 'tool_result') {
          for (const c of Array.isArray(b.content) ? b.content : []) {
            if (c && c.url) citations.push({ metadata: { url: c.url, title: c.title || c.url } });
          }
        }
        // "thinking" blocks are left out, as with ChatGPT's reasoning.
      }

      const parent = m.parent_message_uuid && byId.has(m.parent_message_uuid) ? m.parent_message_uuid : ROOT_ID;
      mapping[m.uuid] = {
        id: m.uuid,
        parent,
        children: [],
        message: {
          id: m.uuid,
          author: { role: m.sender === 'human' ? 'user' : 'assistant' },
          create_time: epoch(m.created_at),
          content: { content_type: 'multimodal_text', parts },
          metadata: { attachments, citations },
        },
      };
    }
    // Children in message order, so a regenerated reply shows as a second version.
    const ordered = [...msgs].sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const m of ordered) mapping[mapping[m.uuid].parent].children.push(m.uuid);

    let leaf = raw.current_leaf_message_uuid;
    if (!leaf || !mapping[leaf]) leaf = ordered.length ? ordered[ordered.length - 1].uuid : ROOT_ID;

    // Artifacts: replay create / rewrite / update along the current branch.
    const branch = [];
    for (let id = leaf; id && id !== ROOT_ID && byId.has(id); id = mapping[id].parent) branch.push(byId.get(id));
    branch.reverse();
    const artifacts = new Map();
    for (const m of branch) {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'tool_use' || b.name !== 'artifacts' || !b.input) continue;
        const input = b.input;
        const key = input.id || input.title;
        const prev = artifacts.get(key);
        if (input.command === 'update' && prev && input.old_str != null) {
          prev.content = prev.content.split(input.old_str).join(input.new_str || '');
          if (input.title) prev.title = input.title;
        } else if (input.content != null) {
          artifacts.set(key, { title: input.title || (prev && prev.title) || key, textdoc_type: artifactType(input.type ? input : (prev ? prev._input : input)), content: input.content, _input: input });
        }
      }
    }

    const conv = {
      title: raw.name || 'Untitled',
      create_time: epoch(raw.created_at),
      update_time: epoch(raw.updated_at),
      conversation_id: raw.uuid,
      default_model_slug: raw.model || null,
      current_node: leaf,
      provider: 'claude',
      chat_url: `https://claude.ai/chat/${raw.uuid}`,
      mapping,
    };
    return { conv, files, artifacts: [...artifacts.values()].map(({ _input, ...doc }) => doc) };
  }

  const api = { claudeToConversation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatSaverClaude = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

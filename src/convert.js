// Pure conversion helpers: ChatGPT conversation JSON -> Markdown, file list, links.
// Loaded as a classic script in the extension (exposes globalThis.ChatSaver)
// and as a CommonJS module in Node tests.
(function (root) {
  'use strict';

  const HIDDEN_CONTENT_TYPES = new Set([
    'thoughts', 'reasoning_recap', 'user_editable_context', 'model_editable_context', 'system_error',
  ]);

  // Walk from current_node up to the root to get the branch the user ended on.
  function linearize(conv) {
    const mapping = conv.mapping || {};
    let nodeId = conv.current_node;
    if (!nodeId || !mapping[nodeId]) {
      // Fall back to the most recent leaf.
      const leaves = Object.values(mapping).filter((n) => !n.children || n.children.length === 0);
      leaves.sort((a, b) => ((a.message && a.message.create_time) || 0) - ((b.message && b.message.create_time) || 0));
      nodeId = leaves.length ? leaves[leaves.length - 1].id : null;
    }
    const path = [];
    const seen = new Set();
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      path.push(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }
    path.reverse();
    return path.map((node) => {
      const parent = node.parent && mapping[node.parent];
      const siblings = parent && parent.children ? parent.children.length : 1;
      return { node, message: node.message, versions: siblings };
    }).filter((x) => x.message);
  }

  function countBranches(conv) {
    return Object.values(conv.mapping || {}).filter((n) => n.children && n.children.length > 1).length;
  }

  function isVisible(msg) {
    if (!msg || !msg.content) return false;
    const md = msg.metadata || {};
    if (md.is_visually_hidden_from_conversation) return false;
    if (msg.author && msg.author.role === 'system') return false;
    if (HIDDEN_CONTENT_TYPES.has(msg.content.content_type)) return false;
    return true;
  }

  function pointerToFileId(pointer) {
    if (!pointer) return null;
    const m = String(pointer).match(/^(?:file-service|sediment):\/\/(.+)$/);
    return m ? m[1] : null;
  }

  function folderFor(role) {
    return role === 'user' ? 'uploads' : 'generated';
  }

  // Collect every file a conversation references, deduplicated by id.
  // Returns [{ id, name, mime, folder, messageId, kind }]
  function collectFiles(conv) {
    const files = new Map();
    const add = (f) => { if (f.id && !files.has(f.id)) files.set(f.id, f); };
    for (const node of Object.values(conv.mapping || {})) {
      const msg = node.message;
      if (!msg) continue;
      const role = msg.author && msg.author.role;
      const md = msg.metadata || {};
      for (const att of md.attachments || []) {
        add({ id: att.id, name: att.name, mime: att.mime_type || att.mimeType, folder: folderFor(role), messageId: msg.id, kind: 'attachment' });
      }
      const parts = (msg.content && msg.content.parts) || [];
      for (const part of parts) {
        if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer') {
          const id = pointerToFileId(part.asset_pointer);
          if (!id) continue;
          const dalle = part.metadata && (part.metadata.dalle || part.metadata.generation);
          add({ id, name: null, mime: 'image/png', folder: dalle || role !== 'user' ? 'generated' : 'uploads', messageId: msg.id, kind: 'image' });
        }
      }
    }
    return [...files.values()];
  }

  // Links like sandbox:/mnt/data/report.csv produced by Code Interpreter.
  function collectSandboxFiles(conv) {
    const out = new Map();
    const re = /sandbox:(\/mnt\/data\/[^\s)\]"']+)/g;
    for (const node of Object.values(conv.mapping || {})) {
      const msg = node.message;
      if (!msg || !msg.content) continue;
      for (const part of msg.content.parts || []) {
        if (typeof part !== 'string') continue;
        let m;
        while ((m = re.exec(part))) {
          const path = decodeURI(m[1]);
          if (!out.has(path)) out.set(path, { sandboxPath: path, name: path.split('/').pop(), messageId: msg.id, folder: 'generated', kind: 'sandbox' });
        }
      }
    }
    return [...out.values()];
  }

  // Canvas documents created in the chat (final content comes from the textdocs endpoint when available).
  function collectCanvasFromMessages(conv) {
    const docs = new Map();
    for (const { message: msg } of linearize(conv)) {
      if (!msg.recipient || !msg.recipient.startsWith('canmore.')) continue;
      const text = (msg.content && (msg.content.text || (msg.content.parts || []).join(''))) || '';
      let payload;
      try { payload = JSON.parse(text); } catch (e) { continue; }
      if (msg.recipient === 'canmore.create_textdoc' && payload.name) {
        docs.set(payload.name, { title: payload.name, type: payload.type, content: payload.content || '' });
      }
    }
    return [...docs.values()];
  }

  function collectLinks(conv) {
    const links = new Map();
    const add = (url, title) => { if (url && /^https?:/.test(url) && !links.has(url)) links.set(url, title || url); };
    for (const node of Object.values(conv.mapping || {})) {
      const md = (node.message && node.message.metadata) || {};
      for (const c of md.citations || []) add(c.metadata && c.metadata.url, c.metadata && c.metadata.title);
      for (const ref of md.content_references || []) {
        for (const item of ref.items || []) add(item.url, item.title);
        if (ref.url) add(ref.url, ref.title);
      }
    }
    return [...links.entries()].map(([url, title]) => ({ url, title }));
  }

  function safeName(name, fallback) {
    const cleaned = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
    return (cleaned || fallback).slice(0, 120);
  }

  function slug(text) {
    return String(text || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';
  }

  function isoDate(ts) {
    if (!ts) return '';
    const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  }

  function folderName(conv) {
    return `${isoDate(conv.create_time) || 'undated'}_${slug(conv.title)}`;
  }

  // Replace citation markers with links where we can, drop the rest.
  function cleanText(text, md) {
    let out = String(text);
    for (const ref of (md && md.content_references) || []) {
      if (!ref.matched_text) continue;
      const item = (ref.items && ref.items[0]) || ref;
      const link = item && item.url ? ` ([${item.title || 'source'}](${item.url}))` : '';
      out = out.split(ref.matched_text).join(link);
    }
    return out
      .replace(/[^]*/g, '')
      .replace(/【[^】]*】/g, '');
  }

  function roleLabel(msg) {
    const role = msg.author && msg.author.role;
    if (role === 'user') return 'You';
    if (role === 'assistant') return 'ChatGPT';
    if (role === 'tool') return `Tool${msg.author.name ? ` (${msg.author.name})` : ''}`;
    return role || 'Unknown';
  }

  function fence(text, lang) {
    const ticks = /```/.test(text) ? '````' : '```';
    return `${ticks}${lang || ''}\n${text}\n${ticks}`;
  }

  // fileIndex: Map<fileId|sandboxPath, relativePath> of files that were saved.
  function renderMessage(msg, fileIndex) {
    const c = msg.content;
    const md = msg.metadata || {};
    const pieces = [];
    const inlineIds = new Set();
    switch (c.content_type) {
      case 'text':
      case 'multimodal_text':
        for (const part of c.parts || []) {
          if (typeof part === 'string') {
            if (part.trim()) pieces.push(cleanText(part, md));
          } else if (part && part.content_type === 'image_asset_pointer') {
            const id = pointerToFileId(part.asset_pointer);
            const rel = fileIndex.get(id);
            inlineIds.add(id);
            pieces.push(rel ? `![image](${encodeURI(rel)})` : `*[image ${id || ''} could not be saved]*`);
          } else if (part && part.content_type === 'audio_transcription' && part.text) {
            pieces.push(`> (voice) ${part.text}`);
          }
        }
        break;
      case 'code':
        if (msg.recipient && msg.recipient.startsWith('canmore.')) {
          pieces.push('*[Canvas updated, see files/canvas]*');
        } else if (c.text) {
          pieces.push(fence(c.text, c.language && c.language !== 'unknown' ? c.language : ''));
        }
        break;
      case 'execution_output':
        if (c.text) pieces.push(fence(c.text, 'text'));
        break;
      case 'tether_quote':
        pieces.push(`> ${String(c.text || '').split('\n').join('\n> ')}${c.url ? `\n> [${c.title || c.url}](${c.url})` : ''}`);
        break;
      default:
        if (c.text) pieces.push(c.text);
        else if (Array.isArray(c.parts)) pieces.push(c.parts.filter((p) => typeof p === 'string').join('\n'));
    }
    for (const att of md.attachments || []) {
      if (inlineIds.has(att.id)) continue;
      const rel = fileIndex.get(att.id);
      pieces.push(rel ? `📎 [${att.name || att.id}](${encodeURI(rel)})` : `📎 ${att.name || att.id} *(could not be saved)*`);
    }
    let body = pieces.join('\n\n');
    // Point sandbox links at saved copies.
    body = body.replace(/\[([^\]]*)\]\(sandbox:(\/mnt\/data\/[^\s)]+)\)/g, (all, label, p) => {
      const rel = fileIndex.get(decodeURI(p));
      return rel ? `[${label}](${encodeURI(rel)})` : `${label} *(file expired before export)*`;
    });
    body = body.replace(/sandbox:(\/mnt\/data\/[^\s)\]"']+)/g, (all, p) => {
      const rel = fileIndex.get(decodeURI(p));
      return rel ? encodeURI(rel) : `${all} (expired before export)`;
    });
    return body.trim();
  }

  function toMarkdown(conv, fileIndex, opts) {
    const options = opts || {};
    const lines = [`# ${conv.title || 'Untitled chat'}`, ''];
    const meta = [
      conv.create_time && `Started ${isoDate(conv.create_time)}`,
      conv.update_time && `last updated ${isoDate(conv.update_time)}`,
      conv.default_model_slug && `model ${conv.default_model_slug}`,
    ].filter(Boolean).join(', ');
    if (meta) lines.push(`*${meta}*`, '');
    if (options.summary) lines.push(options.summary.trim(), '', '---', '');
    const branches = countBranches(conv);
    if (branches) lines.push(`> This chat has ${branches} point(s) where a message was edited or regenerated. This transcript follows the final version; every version is in conversation.json.`, '');
    // A regenerated reply can branch on a hidden node (e.g. reasoning), so carry the count to the next shown message.
    let pendingVersions = 1;
    for (const { message: msg, versions: own } of linearize(conv)) {
      pendingVersions = Math.max(pendingVersions, own);
      if (!isVisible(msg)) continue;
      const body = renderMessage(msg, fileIndex || new Map());
      if (!body) continue;
      const versions = pendingVersions;
      pendingVersions = 1;
      const model = msg.metadata && msg.metadata.model_slug;
      const header = `## ${roleLabel(msg)}${model && msg.author.role === 'assistant' ? ` · ${model}` : ''}`;
      lines.push(header, '');
      if (versions > 1) lines.push(`*(1 of ${versions} versions shown)*`, '');
      lines.push(body, '');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  // Plain transcript for the AI summary prompt, trimmed to maxChars (keeps start and end).
  function toPlainText(conv, maxChars) {
    const out = [];
    for (const { message: msg } of linearize(conv)) {
      if (!isVisible(msg)) continue;
      const body = renderMessage(msg, new Map());
      if (body) out.push(`${roleLabel(msg).toUpperCase()}:\n${body}`);
    }
    const text = out.join('\n\n');
    const limit = maxChars || 120000;
    if (text.length <= limit) return text;
    const head = Math.floor(limit * 0.4);
    return `${text.slice(0, head)}\n\n[... middle of the chat omitted for length ...]\n\n${text.slice(text.length - (limit - head))}`;
  }

  function linksMarkdown(links) {
    if (!links.length) return '# Links\n\nNo web sources were cited in this chat.\n';
    return `# Links\n\n${links.map((l) => `- [${l.title.replace(/[[\]]/g, '')}](${l.url})`).join('\n')}\n`;
  }

  // README used when no AI key is set, or as the lower half under the AI summary.
  function readmeMarkdown(conv, saved, failed, links, summary) {
    const lines = [`# ${conv.title || 'Untitled chat'}`, ''];
    if (summary) lines.push(summary.trim(), '', '---', '');
    const visible = linearize(conv).filter((x) => isVisible(x.message));
    lines.push('## About this export', '',
      `- Started: ${isoDate(conv.create_time) || 'unknown'}`,
      `- Messages: ${visible.length}`,
      `- Files saved: ${saved.length}${failed.length ? `, ${failed.length} could not be saved` : ''}`,
      `- Web sources: ${links.length}`,
      conv.conversation_id ? `- Original chat: https://chatgpt.com/c/${conv.conversation_id}` : '',
      '', '## What is in this folder', '',
      '- `transcript.md`: the full chat, with files linked inline',
      '- `conversation.json`: the complete original data, including edited and regenerated versions',
      '- `files/`: uploads, generated files and canvas documents',
      '- `links.md`: every web source cited',
      '- `continue.md`: paste into a new ChatGPT or Claude chat to pick up where you left off', '');
    if (saved.length) {
      lines.push('## Files', '', '| File | Folder |', '| --- | --- |');
      for (const f of saved) lines.push(`| [${f.fileName}](${encodeURI(f.path)}) | ${f.folder} |`);
      lines.push('');
    }
    if (failed.length) {
      lines.push('## Files that could not be saved', '');
      for (const f of failed) lines.push(`- ${f.name || f.sandboxPath || f.id}: ${f.error}`);
      lines.push('');
    }
    return lines.filter((l) => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
  }

  // Fallback continue brief when no AI key is set: title + the last messages.
  function continueFallback(conv, maxChars) {
    const text = toPlainText(conv, maxChars || 20000);
    return [
      `I'm continuing a previous conversation titled "${conv.title || 'Untitled'}".`,
      'Below is the transcript (trimmed if long). Read it, then briefly confirm where we left off and what the next step is.',
      '', '---', '', text,
    ].join('\n');
  }

  const api = {
    linearize, countBranches, isVisible, pointerToFileId, collectFiles, collectSandboxFiles,
    collectCanvasFromMessages, collectLinks, safeName, slug, isoDate, folderName, cleanText,
    renderMessage, toMarkdown, toPlainText, linksMarkdown, readmeMarkdown, continueFallback,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatSaver = Object.assign(root.ChatSaver || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

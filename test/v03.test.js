const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { claudeToConversation } = require('../src/providers/claude-convert.js');
const { exportConversation } = require('../src/exporter.js');
const { search } = require('../src/search.js');
const { render } = require('../src/markdown.js');
const raw = require('./fixture-claude.json');
const chatgpt = require('./fixture-conversation.json');

async function folderFiles(zip, folder) {
  const out = {};
  for (const [p, e] of Object.entries(zip.files)) if (!e.dir) out[p.slice(folder.length + 1)] = await e.async('string');
  return out;
}

test('Claude chats convert to the shared shape and export with files and artifacts', async () => {
  const { conv, files, artifacts } = claudeToConversation(raw);
  assert.strictEqual(conv.provider, 'claude');
  assert.strictEqual(conv.chat_url, 'https://claude.ai/chat/4c1d2e3f-aaaa-4bbb-8ccc-0123456789ab');
  assert.strictEqual(files['img-1'].url, '/api/org-1/files/img-1/preview');
  assert.strictEqual(files['doc-1'].url, '/api/org-1/files/doc-1/document_pdf');
  assert.deepStrictEqual(artifacts, [
    { title: 'Landing copy', textdoc_type: 'document', content: '# Never lose a chat\n\nEvery chat, every file, saved.' },
    { title: 'Hero section', textdoc_type: 'code/html', content: '<h1>Hi</h1>' },
  ]);

  const downloadFile = async (ref) => {
    const f = files[ref.id];
    return f.text != null ? { bytes: Buffer.from(f.text), name: f.name } : { bytes: new Uint8Array([1]), contentType: 'image/png', name: f.name };
  };
  const { zip, folder, report } = await exportConversation(conv, { JSZip, downloadFile, fetchTextdocs: async () => artifacts });
  const out = await folderFiles(zip, folder);
  assert.deepStrictEqual(Object.keys(out).filter((p) => p.startsWith('files/')).sort(), [
    'files/canvas/Hero section.html', 'files/canvas/Landing copy.md', 'files/uploads/brief.txt', 'files/uploads/research.pdf', 'files/uploads/screenshot.png',
  ]);
  const t = out['transcript.md'];
  assert.match(t, /^## Claude$/m);
  assert.match(t, /!\[image\]\(files\/uploads\/screenshot\.png\)/);
  assert.match(t, /\[Used web_search: "AI chat backup tools"\]/);
  assert.match(t, /1 of 2 versions shown/);
  assert.doesNotMatch(t, /secret reasoning|Abandoned branch/);
  assert.match(out['links.md'], /Cited page/);
  assert.match(out['links.md'], /Backup study/);
  assert.match(out['README.md'], /Original chat: https:\/\/claude\.ai\/chat\//);
  assert.match(out['continue.md'], /CLAUDE:/);
  assert.strictEqual(report.filesFailed.length, 0);
});

test('incremental export reuses files saved before and only writes what changed', async () => {
  let downloads = 0;
  const downloadFile = async () => { downloads++; return { bytes: new Uint8Array([1]), contentType: 'image/png' }; };
  const first = await exportConversation(chatgpt, { JSZip, folder: 'fixed', downloadFile });
  const firstDownloads = downloads;
  assert.ok(first.written.includes('files/uploads/whiteboard.jpg'));
  const second = await exportConversation(chatgpt, { JSZip, folder: 'fixed', downloadFile, existingFiles: first.files });
  // Everything that downloaded before is reused; only the expired sandbox file is tried again.
  assert.strictEqual(downloads - firstDownloads, 0);
  assert.strictEqual(second.folder, 'fixed');
  assert.ok(!second.written.some((p) => p.startsWith('files/uploads/') || p.startsWith('files/generated/')));
  assert.match(second.transcript, /files\/uploads\/whiteboard\.jpg/);
});

test('search ranks title matches first and needs every word', () => {
  const records = [
    { key: 'a', provider: 'chatgpt', title: 'Budget review', transcript: 'we talked about marketing', updateTime: 1 },
    { key: 'b', provider: 'claude', title: 'Marketing plan', transcript: 'budget numbers and marketing', updateTime: 2 },
    { key: 'c', provider: 'chatgpt', title: 'Holiday', transcript: 'nothing relevant', updateTime: 3 },
  ];
  assert.deepStrictEqual(search(records, 'marketing').map((h) => h.record.key), ['b', 'a']);
  assert.deepStrictEqual(search(records, 'marketing budget').map((h) => h.record.key).sort(), ['a', 'b']);
  assert.deepStrictEqual(search(records, 'marketing', 'claude').map((h) => h.record.key), ['b']);
  assert.deepStrictEqual(search(records, '').map((h) => h.record.key), ['c', 'b', 'a']);
  assert.match(search(records, 'numbers')[0].snippet, /numbers/);
});

test('markdown renderer escapes HTML and blocks unsafe links', () => {
  const html = render('# Hi\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) [ok](https://a.com)\n\n```js\nconst a = "<b>";\n```');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<a href="https:\/\/a\.com"/);
  assert.match(html, /&lt;b&gt;/);
});

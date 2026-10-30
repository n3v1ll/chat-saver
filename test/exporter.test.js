const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const C = require('../src/convert.js');
const { exportConversation } = require('../src/exporter.js');
const S = require('../src/summary.js');
const conv = require('./fixture-conversation.json');

function fakeDownload(ref) {
  if (ref.sandboxPath === '/mnt/data/old.csv') return Promise.reject(new Error('expired'));
  const types = { 'file-PDF1': 'application/pdf', 'file-IMG1': 'image/jpeg', file_GEN1: 'image/png' };
  return Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), contentType: types[ref.id] || 'image/png', name: ref.id === 'file_GEN1' ? null : undefined });
}

async function readZip(zip, folder) {
  const out = {};
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[path.slice(folder.length + 1)] = await entry.async('string');
  }
  return out;
}

test('follows the final branch and skips hidden messages', () => {
  const ids = C.linearize(conv).filter((x) => C.isVisible(x.message)).map((x) => x.message.id);
  assert.deepStrictEqual(ids, ['m1', 'm3', 'm4', 'm5', 'm6', 'm7']);
});

test('collects uploads, generated images and sandbox files once each', () => {
  const files = C.collectFiles(conv);
  assert.deepStrictEqual(files.map((f) => [f.id, f.folder]).sort(), [['file-IMG1', 'uploads'], ['file-PDF1', 'uploads'], ['file_GEN1', 'generated']]);
  assert.deepStrictEqual(C.collectSandboxFiles(conv).map((f) => f.sandboxPath), ['/mnt/data/chart.png', '/mnt/data/old.csv']);
});

test('builds the full folder with summary at the top', async () => {
  const { zip, folder, report } = await exportConversation(conv, {
    JSZip,
    downloadFile: fakeDownload,
    summarize: async () => S.parseReply('## Summary\n\nWe reviewed the Q4 plan.\n===CONTINUE===\nWe have been working on a Q4 plan.'),
  });
  assert.strictEqual(folder, '2025-10-30_marketing-plan-review');
  const files = await readZip(zip, folder);
  assert.deepStrictEqual(Object.keys(files).sort(), [
    'README.md', 'continue.md', 'conversation.json', 'export-report.json',
    'files/canvas/Launch email.md', 'files/generated/chart.png', 'files/generated/file_GEN1.png',
    'files/uploads/Q4 plan.pdf', 'files/uploads/whiteboard.jpg', 'links.md', 'transcript.md',
  ]);

  const t = files['transcript.md'];
  assert.ok(t.indexOf('# AI summary') < t.indexOf('## You'), 'summary comes before the chat');
  assert.match(t, /!\[image\]\(files\/uploads\/whiteboard\.jpg\)/);
  assert.match(t, /\[Q4 plan\.pdf\]\(files\/uploads\/Q4%20plan\.pdf\)/);
  assert.match(t, /\[Download chart\]\(files\/generated\/chart\.png\)/);
  assert.match(t, /old one here \*\(file expired before export\)\*/);
  assert.strictEqual(t.match(/whiteboard\.jpg/g).length, 1, 'inline image not repeated as attachment');
  assert.match(t, /\(\[Budget report 2025\]\(https:\/\/example\.com\/budgets\)\)/);
  assert.doesNotMatch(t, /【|/);
  assert.doesNotMatch(t, /Old regenerated answer/);
  assert.match(t, /1 of 2 versions shown/);
  assert.match(t, /```python\nprint\('hello'\)\n```/);

  assert.ok(files['README.md'].startsWith('# Marketing plan review\n\n# AI summary'));
  assert.match(files['README.md'], /old\.csv: code sandbox file expired/);
  assert.match(files['links.md'], /Peer study/);
  assert.strictEqual(files['continue.md'], 'We have been working on a Q4 plan.');
  assert.strictEqual(files['files/canvas/Launch email.md'], "Subject: We're live\n\nHello team...");
  assert.strictEqual(report.filesSaved, 5);
  assert.strictEqual(report.filesFailed.length, 1);
  assert.strictEqual(report.aiSummary, 'included');
});

test('works without an AI key and when the summary call fails', async () => {
  const a = await exportConversation(conv, { JSZip, downloadFile: fakeDownload, summarize: async () => ({ skipped: true }) });
  assert.strictEqual(a.report.aiSummary, 'not configured');
  const files = await readZip(a.zip, a.folder);
  assert.match(files['continue.md'], /continuing a previous conversation/);

  const b = await exportConversation(conv, { JSZip, downloadFile: fakeDownload, summarize: async () => { throw new Error('bad key'); } });
  assert.strictEqual(b.report.aiSummary, 'failed: bad key');
});

test('builds provider requests', () => {
  const o = S.buildRequest({ provider: 'openai', apiKey: 'k' }, 'hi');
  assert.strictEqual(o.url, 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(JSON.parse(o.init.body).model, 'gpt-5-mini');
  assert.strictEqual(o.extract({ choices: [{ message: { content: 'x' } }] }), 'x');
  const a = S.buildRequest({ provider: 'anthropic', apiKey: 'k' }, 'hi');
  assert.strictEqual(a.init.headers['x-api-key'], 'k');
  assert.strictEqual(a.extract({ content: [{ type: 'text', text: 'y' }] }), 'y');
});

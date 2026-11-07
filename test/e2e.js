// End-to-end check: loads the unpacked extension in Chromium against a mocked chatgpt.com and inspects the ZIP.
// Needs Playwright with Chromium installed: npm run test:e2e
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const assert = require('assert');
const ext = path.resolve(__dirname, '..');
const conv = JSON.parse(fs.readFileSync(path.join(ext, 'test/fixture-conversation.json'), 'utf8'));
const ID = conv.conversation_id;
(async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', acceptDownloads: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const calls = [];
  await ctx.route('https://chatgpt.com/**', async (route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname + ' auth=' + !!route.request().headers()['authorization']);
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { accessToken: 'tok' } });
    if (url.pathname === `/backend-api/conversation/${ID}`) return route.fulfill({ json: conv });
    if (url.pathname === '/backend-api/conversations') return route.fulfill({ json: { items: [{ id: ID, title: conv.title, update_time: '2025-10-30T05:00:00Z' }, { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Gone chat' }], total: 2 } });
    if (url.pathname.startsWith('/backend-api/conversation/aaaaaaaa')) return route.fulfill({ status: 404, json: {} });
    if (url.pathname.endsWith('/textdocs')) return route.fulfill({ json: [{ title: 'Launch email', textdoc_type: 'document', content: 'FINAL VERSION' }] });
    if (url.pathname.endsWith('/interpreter/download')) {
      if (url.searchParams.get('sandbox_path') === '/mnt/data/chart.png') return route.fulfill({ json: { download_url: 'https://files.oaiusercontent.com/chart?sig=1', file_name: 'chart.png' } });
      return route.fulfill({ json: { status: 'error', error_code: 'file_expired' } });
    }
    if (url.pathname.startsWith('/backend-api/files/download/')) {
      const id = url.pathname.split('/').pop();
      return route.fulfill({ json: { status: 'success', download_url: `/backend-api/estuary/content?id=${id}`, file_name: id === 'file_GEN1' ? 'banner.png' : null } });
    }
    if (url.pathname === '/backend-api/estuary/content') return route.fulfill({ body: Buffer.from('BYTES-' + url.searchParams.get('id')), contentType: 'application/octet-stream' });
    return route.fulfill({ contentType: 'text/html', body: '<html><body><h1>fake chatgpt</h1></body></html>' });
  });
  await ctx.route('https://files.oaiusercontent.com/**', (r) => r.fulfill({ body: Buffer.from('PNGDATA'), contentType: 'image/png' }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker', {timeout: 10000}); console.log('sw:', sw.url());
  await sw.evaluate(() => chrome.storage.local.set({ provider: 'anthropic', apiKey: 'test-key' }));
  await ctx.route('https://api.anthropic.com/**', (r) => { const b = JSON.parse(r.request().postData()); console.log('anthropic model:', b.model, 'key:', r.request().headers()['x-api-key']); r.fulfill({ json: { content: [{ type: 'text', text: '## Summary\n\nReviewed Q4 plan.\n===CONTINUE===\nWe have been working on the Q4 plan.' }] } }); });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log('console:', m.text()));
  await page.goto(`https://chatgpt.com/c/${ID}`);
  const btn = page.locator('#chat-saver-btn');
  await btn.waitFor({ timeout: 10000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), btn.click()]);
  const file = await dl.path();
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  console.log('download name:', dl.suggestedFilename());
  for (const [p, e] of Object.entries(zip.files)) if (!e.dir) console.log(' ', p, (await e.async('string')).slice(0, 70).replace(/\n/g, ' '));
  const toastText = await page.locator('#chat-saver-toast').innerText();
  console.log('toast:', toastText);
  assert.match(toastText, /^Saved\. 5 file\(s\) saved/);
  assert.ok(zip.file(/README\.md$/)[0], 'single save has a README');
  assert.match(await zip.file(/README\.md$/)[0].async('string'), /# AI summary/);

  // Bulk: drive the same messages the toolbar popup sends.
  const send = (msg) => sw.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    return chrome.tabs.sendMessage(tab.id, m);
  }, msg);
  const listed = await send({ type: 'listConversations', offset: 0 });
  console.log('listed:', JSON.stringify(listed.result.items.map((c) => c.title)));
  const [bulk] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), send({ type: 'saveMany', items: listed.result.items, withSummary: false })]);
  const bzip = await JSZip.loadAsync(fs.readFileSync(await bulk.path()));
  console.log('bulk name:', bulk.suggestedFilename());
  console.log('bulk top-level:', Object.keys(bzip.files).filter((p) => !p.includes('/') || p.split('/').length === 2 && p.endsWith('/')).join(', '));
  console.log(await bzip.file('index.md').async('string'));
  const bulkToast = await page.locator('#chat-saver-toast').innerText();
  console.log('bulk toast:', bulkToast);
  assert.match(bulkToast, /Saved 1 chat\(s\)\. 1 failed/);
  assert.match(await bzip.file('index.md').async('string'), /Gone chat: ChatGPT returned 404/);

  // Import page: feed it a small fake official export.
  const src = new JSZip();
  src.file('conversations.json', JSON.stringify([conv]));
  src.file('file-PDF1-Q4 plan.pdf', 'pdf');
  const exportPath = path.join(require('os').tmpdir(), 'fake-chatgpt-export.zip');
  fs.writeFileSync(exportPath, await src.generateAsync({ type: 'nodebuffer' }));
  const extId = new URL(sw.url()).host;
  const imp = await ctx.newPage();
  await imp.goto(`chrome-extension://${extId}/src/import.html`);
  await imp.setInputFiles('#file', exportPath);
  await imp.locator('#build:not([disabled])').waitFor({ timeout: 10000 });
  console.log('import status:', await imp.locator('#status').innerText());
  const [idl] = await Promise.all([imp.waitForEvent('download', { timeout: 30000 }), imp.click('#build')]);
  const izip = await JSZip.loadAsync(fs.readFileSync(await idl.path()));
  console.log('import zip:', idl.suggestedFilename(), Object.keys(izip.files).filter((n) => !n.endsWith('/')).length, 'files;', Object.keys(izip.files).filter((n) => n.includes('uploads/') && !n.endsWith('/')).join(', '));
  const importStatus = await imp.locator('#status').innerText();
  console.log('import status:', importStatus);
  assert.strictEqual(importStatus, 'Done. 1 chats saved.');
  assert.ok(izip.file(/files\/uploads\/Q4 plan\.pdf$/)[0], 'import keeps the uploaded file');
  await ctx.close();
  console.log('E2E SAVE/BULK/IMPORT: PASS');
})().catch((e) => { console.error(e); process.exit(1); });

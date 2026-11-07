// End-to-end check for v0.3: auto-backup (ChatGPT and Claude), the library page, and the self-test,
// against mocked chatgpt.com and claude.ai. Needs Playwright with Chromium: npm run test:e2e
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

const ext = path.resolve(__dirname, '..');
const gpt = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-conversation.json'), 'utf8'));
const claude = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-claude.json'), 'utf8'));
const GPT_ID = gpt.conversation_id;
const BIG = Buffer.alloc(6 * 1024 * 1024, 7); // a 6 MB upload, to check large files survive the backup path
const old = (s) => new Date(Date.now() - s * 1000).toISOString();

(async () => {
  // Chromium's own download handling is used (so extension file names and folders are kept): files land in ~/Downloads.
  const backupDir = path.join(os.homedir(), 'Downloads', 'Chat Saver');
  fs.rmSync(backupDir, { recursive: true, force: true });
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dl-'));
  const ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', acceptDownloads: true, downloadsPath: downloadsDir,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let gptUpdated = old(3600);

  await ctx.route('https://chatgpt.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { accessToken: 'tok' } });
    if (url.pathname === '/backend-api/conversations') {
      return route.fulfill({ json: { items: [
        { id: GPT_ID, title: gpt.title, update_time: gptUpdated },
        { id: '11111111-2222-4333-8444-555555555555', title: 'Still typing', update_time: old(10) },
      ], total: 2 } });
    }
    if (url.pathname === `/backend-api/conversation/${GPT_ID}`) return route.fulfill({ json: gpt });
    if (url.pathname.endsWith('/textdocs')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('/interpreter/download')) return route.fulfill({ json: { status: 'error', error_code: 'file_expired' } });
    if (url.pathname.startsWith('/backend-api/files/download/')) {
      const id = url.pathname.split('/').pop();
      return route.fulfill({ json: { download_url: `/backend-api/estuary/content?id=${id}` } });
    }
    if (url.pathname === '/backend-api/estuary/content') {
      return route.fulfill({ body: url.searchParams.get('id') === 'file-PDF1' ? BIG : Buffer.from('IMG'), contentType: 'application/octet-stream' });
    }
    return route.fulfill({ contentType: 'text/html', body: '<html><head><meta charset="utf-8"></head><body>fake chatgpt<div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div></body></html>' });
  });

  const claudeCalls = [];
  await ctx.route('https://claude.ai/**', async (route) => {
    const url = new URL(route.request().url());
    claudeCalls.push(url.pathname);
    if (url.pathname === '/api/organizations') return route.fulfill({ json: [{ uuid: 'org-1', capabilities: ['chat'] }] });
    if (url.pathname === '/api/organizations/org-1/chat_conversations') return route.fulfill({ json: [{ uuid: claude.uuid, name: claude.name, updated_at: old(7200) }] });
    if (url.pathname === `/api/organizations/org-1/chat_conversations/${claude.uuid}`) return route.fulfill({ json: claude });
    if (url.pathname.startsWith('/api/org-1/files/')) return route.fulfill({ body: Buffer.from('CLAUDEFILE'), contentType: 'image/png' });
    return route.fulfill({ contentType: 'text/html', body: '<html><head><meta charset="utf-8"></head><body>fake claude<div contenteditable="true" class="ProseMirror"></div></body></html>' });
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ autoBackup: true, backupFolder: 'Chat Saver' }));
  const send = (urlPattern, msg) => sw.evaluate(async ([u, m]) => {
    const [tab] = await chrome.tabs.query({ url: u });
    return chrome.tabs.sendMessage(tab.id, m);
  }, [urlPattern, msg]);
  const downloads = () => sw.evaluate(() => new Promise((r) => chrome.downloads.search({ state: 'complete' }, (items) => r(items.map((i) => ({ id: i.id, file: i.filename, size: i.fileSize }))))));

  // 1. ChatGPT backup
  const gptPage = await ctx.newPage();
  // Hand downloads back to Chromium so it keeps real file names and folders (Playwright otherwise renames them to GUIDs).
  const cdp = await ctx.newCDPSession(gptPage);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  await gptPage.goto(`https://chatgpt.com/c/${GPT_ID}`);
  await gptPage.locator('#chat-saver-btn').waitFor();
  const r1 = await send('https://chatgpt.com/*', { type: 'backupTick', force: true });
  console.log('chatgpt tick:', JSON.stringify(r1.result));
  assert.strictEqual(r1.result.done, 1, 'one chat backed up, the active one skipped');
  let files = await downloads();
  const rel = files.map((f) => f.file.replace(/\\/g, '/').split('/Chat Saver/')[1]).filter(Boolean).sort();
  console.log('written:', rel.join('\n  '));
  const big = files.find((f) => f.file.endsWith('Q4 plan.pdf'));
  assert.ok(big && big.size === BIG.length, `6 MB file written in full (got ${big && big.size})`);
  assert.ok(rel.some((p) => p.startsWith('ChatGPT/') && p.endsWith('/transcript.md')));

  // 2. Second tick: nothing changed, nothing written
  const lastId = Math.max(...files.map((f) => f.id));
  const r2 = await send('https://chatgpt.com/*', { type: 'backupTick', force: true });
  assert.strictEqual(r2.result.done, 0);
  // 3. Chat updated: only text files rewritten, uploads reused
  gptUpdated = old(600);
  const r3 = await send('https://chatgpt.com/*', { type: 'backupTick', force: true });
  assert.strictEqual(r3.result.done, 1);
  await new Promise((r) => setTimeout(r, 4500)); // index.md is written a few seconds after the last chat
  files = await downloads();
  const newOnes = files.filter((f) => f.id > lastId).map((f) => path.basename(f.file));
  console.log('rewritten on update:', newOnes.join(', '));
  assert.ok(!newOnes.includes('Q4 plan.pdf'), 'unchanged upload not downloaded again');

  // 4. Claude backup + self-test
  const cPage = await ctx.newPage();
  await cPage.goto(`https://claude.ai/chat/${claude.uuid}`);
  await cPage.locator('#chat-saver-btn').waitFor();
  const r4 = await send('https://claude.ai/*', { type: 'backupTick', force: true });
  assert.strictEqual(r4.result.done, 1);
  const test = await send('https://claude.ai/*', { type: 'selfTest' });
  console.log('claude self-test:', test.result.results.map((t) => `${t.ok ? 'ok' : 'FAIL'} ${t.name}: ${t.detail}`).join(' | '));
  assert.ok(test.result.results.every((t) => t.ok));
  const gTest = await send('https://chatgpt.com/*', { type: 'selfTest' });
  console.log('chatgpt self-test:', gTest.result.results.map((t) => `${t.ok ? 'ok' : 'FAIL'} ${t.name}: ${t.detail}`).join(' | '));

  // 5. Library page search
  const lib = await ctx.newPage();
  await lib.setViewportSize({ width: 1280, height: 800 });
  await lib.goto(`chrome-extension://${extId}/src/library.html`);
  await lib.locator('.result').first().waitFor();
  console.log('library rows:', await lib.locator('.result .t').allInnerTexts());
  await lib.fill('#search', 'punchier');
  await lib.waitForTimeout(200);
  const hits = await lib.locator('.result .t').allInnerTexts();
  assert.deepStrictEqual(hits, ['Landing page copy']);
  await lib.locator('.result').first().click();
  await lib.locator('#viewer h1').waitFor();
  console.log('viewer title:', await lib.locator('#viewer h1').innerText());
  console.log('status:', await lib.locator('#backupStatus').innerText());
  if (process.env.SHOTS) {
    await lib.fill('#search', '');
    await lib.locator('.result').first().click();
    await lib.screenshot({ path: path.join(process.env.SHOTS, '5-library.png') });
  }
  // 6. Continue a ChatGPT chat in Claude (button on the chat page), and a Claude chat in ChatGPT (library)
  const [claudeNew] = await Promise.all([ctx.waitForEvent('page'), gptPage.click('#chat-saver-cont')]);
  await claudeNew.waitForURL('https://claude.ai/new');
  await claudeNew.waitForFunction(() => /continuing a previous conversation/.test((document.querySelector('.ProseMirror') || {}).textContent), null, { timeout: 15000 });
  console.log('continue in Claude: brief filled,', (await claudeNew.locator('.ProseMirror').innerText()).length, 'chars');
  await lib.bringToFront();
  const [gptNew] = await Promise.all([ctx.waitForEvent('page'), lib.click('#vContGpt')]);
  await gptNew.waitForURL('https://chatgpt.com/');
  await gptNew.waitForFunction(() => /Landing page copy/.test((document.querySelector('#prompt-textarea') || {}).textContent), null, { timeout: 15000 });
  console.log('continue in ChatGPT from library: brief filled');
  // A tab the user opens themselves must not receive the brief.
  const other = await ctx.newPage();
  await other.goto('https://chatgpt.com/');
  await other.waitForTimeout(2000);
  assert.strictEqual(await other.locator('#prompt-textarea').innerText(), '');

  await new Promise((r) => setTimeout(r, 4500));
  const index = fs.readFileSync(path.join(backupDir, 'index.md'), 'utf8');
  assert.match(index, /2 chats backed up/);
  console.log('backup folder:', execSync(`cd "${backupDir}" && find . -type f | sort`).toString().trim().split('\n').join('\n  '));
  await ctx.close();
  console.log('E2E BACKUP: PASS');
})().catch((e) => { console.error(e); process.exit(1); });

// Service worker: fetches file downloads (cross-origin), calls the AI provider for summaries,
// and writes auto-backups to the Downloads folder while keeping the searchable library in IndexedDB.
importScripts('summary.js', 'db.js');

const PROVIDER_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude' };

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchBinary(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  return { base64: toBase64(buffer), contentType: res.headers.get('content-type') || '' };
}

async function summarize(title, transcript) {
  const settings = await chrome.storage.local.get(['provider', 'apiKey', 'model']);
  if (!settings.apiKey) return { skipped: true };
  const req = ChatSaverSummary.buildRequest(settings, ChatSaverSummary.buildPrompt(title, transcript));
  const res = await fetch(req.url, req.init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json.error && json.error.message) || `HTTP ${res.status}`);
  return ChatSaverSummary.parseReply(req.extract(json));
}

// ---- Auto-backup ----

async function backupRoot() {
  const { backupFolder } = await chrome.storage.local.get('backupFolder');
  return String(backupFolder || 'Chat Saver').replace(/[\\:*?"<>|]/g, '_').replace(/^\/+|\/+$/g, '') || 'Chat Saver';
}

// Only one tab backs up at a time. The lock expires so a closed tab can't block backups forever.
let lock = null;
function takeLock(owner) {
  if (lock && lock.owner !== owner && Date.now() - lock.at < 10 * 60 * 1000) return false;
  lock = { owner, at: Date.now() };
  return true;
}

function downloadAndWait(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (id) => {
      if (chrome.runtime.lastError || id === undefined) return reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'download failed'));
      const listener = (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          if (delta.state.current === 'complete') resolve(id);
          else reject(new Error('download interrupted'));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

// Backups write quietly: the download bubble is hidden while files are written.
let quietWrites = 0;
async function quiet(fn) {
  quietWrites++;
  try {
    if (chrome.downloads.setUiOptions) await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
    return await fn();
  } finally {
    quietWrites--;
    if (!quietWrites && chrome.downloads.setUiOptions) await chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
  }
}

async function writeFile(relPath, base64, mime) {
  const filename = `${await backupRoot()}/${relPath}`;
  return quiet(() => downloadAndWait({
    url: `data:${mime || 'application/octet-stream'};base64,${base64}`,
    filename,
    conflictAction: 'overwrite',
    saveAs: false,
  }));
}

function utf8ToBase64(text) {
  return toBase64(new TextEncoder().encode(text));
}

function libraryIndexMarkdown(records) {
  const sorted = [...records].sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0));
  const cell = (t) => String(t || 'Untitled').replace(/\|/g, '\\|').replace(/[[\]]/g, '');
  const lines = ['# My AI chats', '', `${records.length} chats backed up by Chat Saver. Last updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`, '',
    '| Chat | App | Last updated | Files |', '| --- | --- | --- | --- |'];
  for (const r of sorted) {
    const dir = `${PROVIDER_LABELS[r.provider] || r.provider}/${r.folder}`;
    lines.push(`| [${cell(r.title)}](${encodeURI(dir)}/README.md) | ${PROVIDER_LABELS[r.provider] || r.provider} | ${r.updated || ''} | ${r.filesSaved || 0} |`);
  }
  return `${lines.join('\n')}\n`;
}

let indexTimer = null;
function scheduleIndex() {
  clearTimeout(indexTimer);
  indexTimer = setTimeout(async () => {
    const records = await ChatDB.all();
    await writeFile('index.md', utf8ToBase64(libraryIndexMarkdown(records)), 'text/markdown').catch(() => {});
  }, 3000);
}

async function backupFile(msg) {
  const label = PROVIDER_LABELS[msg.provider] || msg.provider;
  return writeFile(`${label}/${msg.folder}/${msg.path}`, msg.base64, msg.mime);
}

async function backupRecord(record) {
  const prev = await ChatDB.get(record.key);
  await ChatDB.put({ ...prev, ...record });
  const { backupStats = {} } = await chrome.storage.local.get('backupStats');
  await chrome.storage.local.set({ backupStats: { ...backupStats, lastBackupAt: Date.now(), lastError: null } });
  chrome.action.setBadgeText({ text: '' });
  scheduleIndex();
  return true;
}

async function backupError(error) {
  const { backupStats = {} } = await chrome.storage.local.get('backupStats');
  await chrome.storage.local.set({ backupStats: { ...backupStats, lastError: { at: Date.now(), message: error } } });
  chrome.action.setBadgeBackgroundColor({ color: '#b00020' });
  chrome.action.setBadgeText({ text: '!' });
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = async () => {
    switch (msg.type) {
      case 'fetchBinary': return fetchBinary(msg.url);
      case 'summarize': return summarize(msg.title, msg.transcript);
      case 'openOptions': return chrome.runtime.openOptionsPage();
      case 'openLibrary': return chrome.tabs.create({ url: chrome.runtime.getURL('src/library.html') });
      case 'backupLock': return takeLock(msg.owner);
      case 'backupUnlock': if (lock && lock.owner === msg.owner) lock = null; return true;
      case 'backupState': return ChatDB.state(msg.provider);
      case 'backupFile': return backupFile(msg);
      case 'backupRecord': return backupRecord(msg.record);
      case 'backupError': return backupError(msg.error);
      case 'showInFolder': return chrome.downloads.show(msg.downloadId);
      default: throw new Error(`Unknown message ${msg.type}`);
    }
  };
  run().then((result) => sendResponse({ ok: true, result }), (err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true; // keep the channel open for the async reply
});

// Nudge open chat tabs to check for changes every few minutes, even if a tab's own timer was throttled.
chrome.alarms.create('backup-tick', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'backup-tick') return;
  const { autoBackup } = await chrome.storage.local.get('autoBackup');
  if (!autoBackup) return;
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://claude.ai/*'] });
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'backupTick' }).catch(() => {});
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/library.html#welcome') });
});

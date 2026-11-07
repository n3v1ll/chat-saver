const $ = (id) => document.getElementById(id);
const { render, escapeHtml } = ChatSaverMarkdown;
const LABELS = { chatgpt: 'ChatGPT', claude: 'Claude' };
const CHAT_TABS = ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://claude.ai/*'];

let records = [];
let provider = '';
let openKey = null;

function highlight(text, words) {
  let html = escapeHtml(text);
  for (const w of words) {
    if (w.length < 2) continue;
    html = html.replace(new RegExp(escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
  }
  return html;
}

function renderResults() {
  const q = $('search').value;
  const words = ChatSaverSearch.terms(q);
  const hits = ChatSaverSearch.search(records, q, provider);
  const box = $('results');
  box.textContent = '';
  if (!records.length) {
    box.innerHTML = '<div class="result muted">Nothing backed up yet. Turn on automatic backup above, or click Back up now with ChatGPT or Claude open in another tab.</div>';
    return;
  }
  if (!hits.length) {
    box.innerHTML = '<div class="result muted">No chats match.</div>';
    return;
  }
  for (const { record: r, snippet } of hits.slice(0, 300)) {
    const el = document.createElement('div');
    el.className = `result${r.key === openKey ? ' on' : ''}`;
    el.innerHTML = `<div class="t">${highlight(r.title || 'Untitled', words)}</div>
      <div class="m"><span class="badge ${r.provider}">${LABELS[r.provider] || r.provider}</span>${escapeHtml(r.updated || '')}${r.filesSaved ? ` · ${r.filesSaved} file(s)` : ''}</div>
      <div class="s">${highlight(snippet, words)}</div>`;
    el.addEventListener('click', () => openRecord(r.key));
    box.append(el);
  }
}

function openRecord(key) {
  const r = records.find((x) => x.key === key);
  if (!r) return;
  openKey = key;
  const v = $('viewer');
  v.innerHTML = `<div class="toolbar">
      ${r.url ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener"><button class="secondary">Open in ${LABELS[r.provider]}</button></a>` : ''}
      ${r.readmeDownloadId ? '<button class="secondary" id="vShow">Show files</button>' : ''}
      <button class="secondary" id="vCopy">Copy transcript</button>
      <button id="vContGpt" title="Open a new ChatGPT chat with a brief of this one, ready to send">Continue in ChatGPT</button>
      <button id="vContClaude" title="Open a new Claude chat with a brief of this one, ready to send">Continue in Claude</button>
      <span class="muted small" style="align-self:center">Saved in Downloads/…/${escapeHtml(LABELS[r.provider] || '')}/${escapeHtml(r.folder)}</span>
    </div>${render(r.transcript || '')}`;
  const show = $('vShow');
  if (show) show.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'showInFolder', downloadId: r.readmeDownloadId }));
  $('vCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(r.transcript || '');
    $('vCopy').textContent = 'Copied';
  });
  for (const [id, target] of [['vContGpt', 'chatgpt'], ['vContClaude', 'claude']]) {
    $(id).addEventListener('click', async () => {
      const text = r.continueText || `I'm continuing a previous conversation titled "${r.title}". Here is the transcript:\n\n${r.transcript || ''}`;
      // Also on the clipboard, in case the site changed and the box can't be filled.
      await navigator.clipboard.writeText(text).catch(() => {});
      chrome.runtime.sendMessage({ type: 'continueIn', target, text, title: r.title });
    });
  }
  v.scrollTop = 0;
  renderResults();
}

async function load() {
  records = await ChatDB.all();
  $('count').textContent = records.length ? `· ${records.length} chats` : '';
  renderResults();
  if (openKey && !document.getElementById('vCopy')) openRecord(openKey);
}

function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

async function refreshStatus() {
  const s = await chrome.storage.local.get(['autoBackup', 'backupSummaries', 'apiKey', 'backupStats', 'backupFolder']);
  $('autoBackup').checked = !!s.autoBackup;
  $('backupSummaries').checked = !!s.backupSummaries;
  $('backupSummaries').disabled = !s.apiKey;
  $('backupSummaries').parentElement.title = s.apiKey ? 'Uses your API key each time a chat changes' : 'Add an API key in Settings first';
  for (const el of document.querySelectorAll('.folder-name')) el.textContent = s.backupFolder || 'Chat Saver';
  const st = s.backupStats || {};
  const tabs = await chrome.tabs.query({ url: CHAT_TABS });
  const parts = [];
  parts.push(s.autoBackup
    ? (tabs.length ? `Automatic backup is on and watching ${tabs.length} chat tab(s).` : 'Automatic backup is on. It runs while ChatGPT or Claude is open in a tab.')
    : 'Automatic backup is off.');
  if (st.lastBackupAt) parts.push(`Last backup ${timeAgo(st.lastBackupAt)}.`);
  if (st.lastError && (!st.lastBackupAt || st.lastError.at > st.lastBackupAt)) parts.push(`Last problem: ${st.lastError.message}`);
  $('backupStatus').textContent = parts.join(' ');
}

$('autoBackup').addEventListener('change', async () => {
  await chrome.storage.local.set({ autoBackup: $('autoBackup').checked });
  if ($('autoBackup').checked) backupNow();
  refreshStatus();
});
$('backupSummaries').addEventListener('change', () => chrome.storage.local.set({ backupSummaries: $('backupSummaries').checked }));

async function backupNow() {
  const tabs = await chrome.tabs.query({ url: CHAT_TABS });
  if (!tabs.length) {
    $('backupStatus').textContent = 'Open ChatGPT or Claude in another tab (and stay logged in), then click Back up now.';
    return;
  }
  $('backupNow').disabled = true;
  $('backupStatus').textContent = 'Backing up… you can keep using your browser. New chats appear below as they are saved.';
  await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'backupTick', force: true }).catch(() => null)));
  $('backupNow').disabled = false;
  await load();
  refreshStatus();
}
$('backupNow').addEventListener('click', backupNow);

$('showFolder').addEventListener('click', () => {
  const r = records.find((x) => x.readmeDownloadId);
  if (r) chrome.runtime.sendMessage({ type: 'showInFolder', downloadId: r.readmeDownloadId });
  else $('backupStatus').textContent = 'Nothing has been backed up yet.';
});

$('search').addEventListener('input', renderResults);
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    provider = chip.dataset.p;
    for (const c of document.querySelectorAll('.chip')) c.classList.toggle('on', c === chip);
    renderResults();
  });
}

if (location.hash === '#welcome') $('welcome').classList.remove('hidden');
load();
refreshStatus();
// Pick up chats saved by open tabs while this page is open.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.backupStats) { load(); refreshStatus(); }
});

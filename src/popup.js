const $ = (id) => document.getElementById(id);
const chats = [];
const selected = new Set();
let hasMore = false;
let tabId = null;
let site = null;
let lastReport = null;

function showError(text) {
  $('msg').textContent = text;
}

function ask(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (reply) => {
      if (chrome.runtime.lastError) return reject(new Error('Reload the chat tab and try again.'));
      if (!reply || !reply.ok) return reject(new Error((reply && reply.error) || 'No reply from the page'));
      resolve(reply.result);
    });
  });
}

const openPage = (path) => chrome.tabs.create({ url: chrome.runtime.getURL(path) });
$('settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
$('library').addEventListener('click', (e) => { e.preventDefault(); openPage('src/library.html'); });
$('import').addEventListener('click', (e) => { e.preventDefault(); openPage('src/import.html'); });

// ---- Auto-backup status ----
chrome.storage.local.get(['autoBackup', 'backupStats', 'apiKey'], (s) => {
  $('autoBackup').checked = !!s.autoBackup;
  const st = s.backupStats || {};
  let line = s.autoBackup ? 'On. New and changed chats are saved to your Downloads folder while ChatGPT or Claude is open.' : 'Off. Turn it on to save every chat without clicking.';
  if (st.lastBackupAt) line += ` Last backup ${new Date(st.lastBackupAt).toLocaleString()}.`;
  if (st.lastError && (!st.lastBackupAt || st.lastError.at > st.lastBackupAt)) line += ` Problem: ${st.lastError.message}`;
  $('backupLine').textContent = line;
  $('summary').disabled = !s.apiKey;
});
$('autoBackup').addEventListener('change', async () => {
  await chrome.storage.local.set({ autoBackup: $('autoBackup').checked });
  if ($('autoBackup').checked) openPage('src/library.html');
});

// ---- Current site ----
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(chatgpt\.com|chat\.openai\.com|claude\.ai)\//.test(tab.url || '')) return;
  tabId = tab.id;
  try {
    site = await ask({ type: 'whoami' });
    $('siteText').textContent = `You're on ${site.label}.`;
    $('siteActions').classList.remove('hidden');
  } catch (err) {
    $('siteText').textContent = err.message;
  }
})();

// ---- Bulk save ----
function render() {
  const q = $('filter').value.trim().toLowerCase();
  const list = $('list');
  list.textContent = '';
  for (const c of chats) {
    if (q && !String(c.title || '').toLowerCase().includes(q)) continue;
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(c.id);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(c.id);
      else selected.delete(c.id);
      updateSave();
    });
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = c.title || 'Untitled';
    t.title = c.title || '';
    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = c.updateTime ? new Date(c.updateTime * 1000).toISOString().slice(0, 10) : '';
    label.append(box, t, d);
    list.append(label);
  }
  $('more').classList.toggle('hidden', !hasMore);
}

function updateSave() {
  $('save').disabled = selected.size === 0;
  $('save').textContent = `Save ${selected.size} chat${selected.size === 1 ? '' : 's'}`;
}

async function loadPage() {
  showError('');
  const page = await ask({ type: 'listConversations', offset: chats.length });
  chats.push(...page.items);
  hasMore = page.hasMore;
  render();
}

$('load').addEventListener('click', async () => {
  try {
    await loadPage();
    $('testBox').classList.add('hidden');
    $('picker').classList.remove('hidden');
  } catch (err) {
    showError(err.message);
  }
});
$('more').addEventListener('click', () => loadPage().catch((err) => showError(err.message)));
$('filter').addEventListener('input', render);
$('all').addEventListener('change', () => {
  const q = $('filter').value.trim().toLowerCase();
  for (const c of chats) {
    if (q && !String(c.title || '').toLowerCase().includes(q)) continue;
    if ($('all').checked) selected.add(c.id);
    else selected.delete(c.id);
  }
  render();
  updateSave();
});
$('save').addEventListener('click', async () => {
  const items = chats.filter((c) => selected.has(c.id)).map((c) => ({ id: c.id, title: c.title }));
  try {
    await ask({ type: 'saveMany', items, withSummary: $('summary').checked });
    window.close(); // progress continues on the chat page
  } catch (err) {
    showError(err.message);
  }
});

// ---- Self-test ----
$('selftest').addEventListener('click', async () => {
  $('picker').classList.add('hidden');
  $('testBox').classList.remove('hidden');
  $('tests').textContent = '';
  $('testSummary').textContent = 'Running…';
  $('selftest').disabled = true;
  try {
    lastReport = await ask({ type: 'selfTest' });
    for (const r of lastReport.results) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✔' : '✘'}</span> `;
      li.append(r.name);
      const d = document.createElement('span');
      d.className = 'detail';
      d.textContent = r.detail;
      li.append(d);
      $('tests').append(li);
    }
    const failed = lastReport.results.filter((r) => !r.ok).length;
    $('testSummary').textContent = failed ? `${failed} check(s) failed. Copy the report and send it to the developer.` : 'All checks passed.';
  } catch (err) {
    $('testSummary').textContent = err.message;
  } finally {
    $('selftest').disabled = false;
  }
});
$('copyReport').addEventListener('click', async () => {
  if (!lastReport) return;
  await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2));
  $('copyReport').textContent = 'Copied';
});

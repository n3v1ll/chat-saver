const $ = (id) => document.getElementById(id);
const chats = [];
const selected = new Set();
let total = 0;
let tabId = null;

function showError(text) {
  $('msg').textContent = text;
}

async function activeChatGptTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) return null;
  return tab.id;
}

function ask(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (reply) => {
      if (chrome.runtime.lastError) return reject(new Error('Reload the ChatGPT tab and try again.'));
      if (!reply || !reply.ok) return reject(new Error((reply && reply.error) || 'No reply from the page'));
      resolve(reply.result);
    });
  });
}

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
    d.textContent = c.updated || '';
    label.append(box, t, d);
    list.append(label);
  }
  $('more').classList.toggle('hidden', chats.length >= total);
}

function updateSave() {
  $('save').disabled = selected.size === 0;
  $('save').textContent = `Save ${selected.size} chat${selected.size === 1 ? '' : 's'}`;
}

async function loadPage() {
  showError('');
  const page = await ask({ type: 'listConversations', offset: chats.length });
  chats.push(...page.items);
  total = page.total || chats.length;
  render();
}

$('settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('import').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('src/import.html') });
});

$('load').addEventListener('click', async () => {
  tabId = await activeChatGptTab();
  if (!tabId) return showError('Open chatgpt.com in this tab first.');
  try {
    await loadPage();
    $('load').classList.add('hidden');
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

chrome.storage.local.get(['apiKey'], (s) => {
  $('summary').disabled = !s.apiKey;
  $('summary').parentElement.title = s.apiKey ? 'Uses your API key once per chat' : 'Add an API key in Settings first';
});

$('save').addEventListener('click', async () => {
  const items = chats.filter((c) => selected.has(c.id)).map((c) => ({ id: c.id, title: c.title }));
  try {
    await ask({ type: 'saveMany', items, withSummary: $('summary').checked });
    window.close(); // progress continues on the ChatGPT page
  } catch (err) {
    showError(err.message);
  }
});

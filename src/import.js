const $ = (id) => document.getElementById(id);
const CS = globalThis.ChatSaver;
let sourceZip = null;
let conversations = [];
const selected = new Set();

const status = (t) => { $('status').textContent = t; };
const showError = (t) => { $('error').textContent = t; };

function matches(conv) {
  const q = $('filter').value.trim().toLowerCase();
  return !q || String(conv.title || '').toLowerCase().includes(q);
}

function render() {
  const list = $('list');
  list.textContent = '';
  for (const conv of conversations) {
    if (!matches(conv)) continue;
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(conv.conversation_id);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(conv.conversation_id);
      else selected.delete(conv.conversation_id);
      updateBuild();
    });
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = conv.title || 'Untitled';
    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = CS.isoDate(conv.update_time);
    label.append(box, t, d);
    list.append(label);
  }
}

function updateBuild() {
  $('build').disabled = selected.size === 0;
  $('build').textContent = `Build archive (${selected.size} chat${selected.size === 1 ? '' : 's'})`;
}

$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  if (!file) return;
  showError('');
  status('Opening ZIP...');
  try {
    sourceZip = await JSZip.loadAsync(file);
    conversations = await ChatSaverImport.readConversations(sourceZip);
    selected.clear();
    for (const c of conversations) selected.add(c.conversation_id);
    $('picker').classList.remove('hidden');
    render();
    updateBuild();
    status(`Found ${conversations.length} chats.`);
  } catch (err) {
    showError(err.message);
    status('');
  }
});

$('filter').addEventListener('input', render);

$('all').addEventListener('change', () => {
  for (const c of conversations) {
    if (!matches(c)) continue;
    if ($('all').checked) selected.add(c.conversation_id);
    else selected.delete(c.conversation_id);
  }
  render();
  updateBuild();
});

chrome.storage.local.get(['apiKey'], (s) => {
  $('summary').disabled = !s.apiKey;
  $('summary').parentElement.title = s.apiKey ? 'Uses your API key once per chat' : 'Add an API key in Settings first';
});

function summarize(title, transcript) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'summarize', title, transcript }, (reply) => {
      if (!reply || !reply.ok) return reject(new Error((reply && reply.error) || 'summary failed'));
      resolve(reply.result);
    });
  });
}

$('build').addEventListener('click', async () => {
  $('build').disabled = true;
  showError('');
  const out = new JSZip();
  const usedFolders = new Set();
  const downloadFile = ChatSaverImport.fileLookup(sourceZip);
  const chosen = conversations.filter((c) => selected.has(c.conversation_id));
  const reports = [];
  for (let i = 0; i < chosen.length; i++) {
    const conv = chosen[i];
    status(`Chat ${i + 1}/${chosen.length}: ${conv.title || 'Untitled'}`);
    try {
      const { report } = await CS.exportConversation(conv, {
        JSZip, zip: out, usedFolders, downloadFile,
        summarize: $('summary').checked ? summarize : null,
      });
      reports.push(report);
    } catch (err) {
      reports.push({ title: conv.title, error: String(err.message || err) });
    }
  }
  out.file('index.md', CS.indexMarkdown(reports));
  out.file('index.json', JSON.stringify(reports, null, 2));
  status('Building ZIP...');
  const blob = await out.generateAsync({ type: 'blob', compression: 'DEFLATE' }, (m) => status(`Building ZIP... ${Math.round(m.percent)}%`));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chatgpt-archive_${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  const failed = reports.filter((r) => r.error).length;
  status(`Done. ${reports.length - failed} chats saved${failed ? `, ${failed} failed (see index.md)` : ''}.`);
  updateBuild();
});

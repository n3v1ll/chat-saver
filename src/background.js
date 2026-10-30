// Service worker: fetches file downloads (cross-origin) and calls the AI provider for summaries.
importScripts('summary.js');

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = async () => {
    if (msg.type === 'fetchBinary') return fetchBinary(msg.url);
    if (msg.type === 'summarize') return summarize(msg.title, msg.transcript);
    if (msg.type === 'openOptions') return chrome.runtime.openOptionsPage();
    throw new Error(`Unknown message ${msg.type}`);
  };
  run().then((result) => sendResponse({ ok: true, result }), (err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true; // keep the channel open for the async reply
});

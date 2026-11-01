// Helpers shared by the content script and the site providers (loaded first on every supported site).
(function (root) {
  'use strict';

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (reply) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!reply || !reply.ok) return reject(new Error((reply && reply.error) || 'No reply from extension'));
        resolve(reply.result);
      });
    });
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Same-origin links are fetched here with the page's login; other hosts go through the background worker (CORS).
  async function fetchBytes(url, headers) {
    const absolute = new URL(url, location.origin);
    if (absolute.origin === location.origin) {
      const res = await fetch(absolute, { credentials: 'include', headers: headers || {} });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
    }
    const got = await sendToBackground({ type: 'fetchBinary', url: absolute.href });
    return { bytes: base64ToBytes(got.base64), contentType: got.contentType };
  }

  root.ChatSaverRuntime = { sendToBackground, base64ToBytes, fetchBytes };
})(globalThis);

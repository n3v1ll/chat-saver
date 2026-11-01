// The library: one record per backed-up chat, kept in the extension's IndexedDB.
// Used by the background worker (writes) and the library page (search).
(function (root) {
  'use strict';

  const DB_NAME = 'chat-saver';
  const STORE = 'chats';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('provider', 'provider');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
      t.onerror = () => reject(t.error);
    });
  }

  const ChatDB = {
    put: (record) => tx('readwrite', (s) => s.put(record)),
    get: (key) => tx('readonly', (s) => s.get(key)),
    all: () => tx('readonly', (s) => s.getAll()),
    remove: (key) => tx('readwrite', (s) => s.delete(key)),
    clear: () => tx('readwrite', (s) => s.clear()),
    // { chatId: updateTime } for one provider, so the content script can skip unchanged chats.
    async state(provider) {
      const rows = await tx('readonly', (s) => s.index('provider').getAll(provider));
      return Object.fromEntries(rows.map((r) => [r.id, { updateTime: r.updateTime, folder: r.folder, files: r.files || {} }]));
    },
  };

  root.ChatDB = ChatDB;
})(globalThis);

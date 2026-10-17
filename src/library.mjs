const DATABASE = 'pdf-translation-library';
let database;

function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
      for (const name of ['translations', 'documentState']) {
        if (db.objectStoreNames.contains(name)) continue;
        db.createObjectStore(name, { keyPath: 'id' }).createIndex('documentId', 'documentId');
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
    request.onerror = () => { database = null; reject(request.error || new Error('无法打开文档库')); };
    request.onblocked = () => { database = null; reject(new Error('请关闭旧版阅读器窗口，再重新打开文档库。')); };
  });
  return database;
}

async function transaction(stores, mode, run) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('文档库写入失败'));
    try { run(tx, (value) => { result = value; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}

export async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const library = {
  async importPdf(bytes, metadata) {
    const id = await digest(bytes);
    return transaction(['documents'], 'readwrite', (tx, result) => {
      const store = tx.objectStore('documents');
      store.get(id).onsuccess = (event) => {
        const previous = event.target.result;
        const document = {
          ...previous, ...metadata, id, size: bytes.byteLength,
          data: previous?.data || new Blob([bytes], { type: 'application/pdf' }),
          name: previous?.name || metadata.name || 'document.pdf', page: previous?.page || 1,
          addedAt: previous?.addedAt || Date.now(), lastOpened: Date.now()
        };
        store.put(document); result(document);
      };
    });
  },
  async list() {
    const rows = await transaction(['documents'], 'readonly', (tx, result) => {
      tx.objectStore('documents').getAll().onsuccess = (event) => result(event.target.result);
    });
    return rows.sort((a, b) => b.lastOpened - a.lastOpened);
  },
  get(id) {
    return transaction(['documents'], 'readonly', (tx, result) => {
      tx.objectStore('documents').get(id).onsuccess = (event) => result(event.target.result);
    });
  },
  patch(id, patch) {
    return transaction(['documents'], 'readwrite', (tx) => {
      const store = tx.objectStore('documents');
      store.get(id).onsuccess = (event) => {
        const previous = event.target.result;
        if (previous) store.put({ ...previous, ...patch, id, data: previous.data, size: previous.size });
      };
    });
  },
  remove(id) {
    return transaction(['documents', 'translations', 'documentState'], 'readwrite', (tx) => {
      tx.objectStore('documents').delete(id);
      for (const name of ['translations', 'documentState']) {
        tx.objectStore(name).index('documentId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) { tx.objectStore(name).delete(cursor.primaryKey); cursor.continue(); }
        };
      }
    });
  },
  loadTranslation(id) {
    return transaction(['translations'], 'readonly', (tx, result) => {
      tx.objectStore('translations').get(id).onsuccess = (event) => result(event.target.result);
    });
  },
  saveTranslation(record) {
    return transaction(['documents', 'translations'], 'readwrite', (tx, result) => {
      // A late translation must not resurrect a document deleted in another tab.
      tx.objectStore('documents').get(record.documentId).onsuccess = (event) => {
        if (!event.target.result) { result(false); return; }
        tx.objectStore('translations').put({ ...record, updatedAt: Date.now() });
        tx.objectStore('documents').put({ ...event.target.result, translation: {
          target: record.target, done: record.done, total: record.total, status: record.status, layoutVersion: record.layoutVersion, updatedAt: Date.now()
        } });
        result(true);
      };
    });
  },
  async loadState(documentId, kind) {
    const row = await transaction(['documentState'], 'readonly', (tx, result) => {
      tx.objectStore('documentState').get(`${documentId}:${kind}`).onsuccess = (event) => result(event.target.result);
    });
    return row?.value ?? null;
  },
  saveState(documentId, kind, value) {
    if (!['reading', 'chat'].includes(kind)) return Promise.reject(new Error('不支持的文档数据类型'));
    return transaction(['documents', 'documentState'], 'readwrite', (tx, result) => {
      tx.objectStore('documents').get(documentId).onsuccess = (event) => {
        if (!event.target.result) { result(false); return; }
        tx.objectStore('documentState').put({ id: `${documentId}:${kind}`, documentId, kind, value, updatedAt: Date.now() });
        result(true);
      };
    });
  },
  snapshot() {
    return transaction(['documents', 'translations', 'documentState'], 'readonly', (tx, result) => {
      const snapshot = { documents: [], translations: [], documentState: [] };
      result(snapshot);
      for (const name of Object.keys(snapshot)) tx.objectStore(name).getAll().onsuccess = (event) => { snapshot[name] = event.target.result; };
    });
  },
  async restore(snapshot) {
    // Validate the complete archive before this atomic merge; newer local work wins.
    const merge = () => transaction(['documents', 'translations', 'documentState'], 'readwrite', (tx) => {
      let pending = snapshot.documents.length + snapshot.translations.length + snapshot.documentState.length;
      const summaries = () => {
        for (const document of snapshot.documents) {
          tx.objectStore('translations').index('documentId').getAll(document.id).onsuccess = (event) => {
            const latest = event.target.result.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0];
            const store = tx.objectStore('documents');
            store.get(document.id).onsuccess = (read) => {
              const row = read.target.result;
              if (!row) return;
              if (latest) row.translation = { target: latest.target, done: latest.done, total: latest.total, status: latest.status, layoutVersion: latest.layoutVersion };
              else delete row.translation;
              store.put(row);
            };
          };
        }
      };
      const completed = () => { if (--pending === 0) summaries(); };
      for (const row of snapshot.documents) {
        const store = tx.objectStore('documents');
        store.get(row.id).onsuccess = (event) => {
          const previous = event.target.result;
          const latest = previous && previous.lastOpened >= row.lastOpened ? previous : row;
          store.put({ ...latest, data: previous?.data || row.data, addedAt: Math.min(previous?.addedAt || row.addedAt, row.addedAt) });
          completed();
        };
      }
      for (const name of ['translations', 'documentState']) for (const row of snapshot[name]) {
        const store = tx.objectStore(name);
        store.get(row.id).onsuccess = (event) => {
          const previous = event.target.result;
          if (!previous || (previous.updatedAt || previous.createdAt || 0) < (row.updatedAt || row.createdAt || 0)) store.put(row);
          completed();
        };
      }
    });
    const keys = [...new Set([
      ...snapshot.documentState.map((row) => row.kind === 'reading' ? `pdf-reading-state:${row.documentId}` : `pdf-chat-state:${row.documentId}`),
      ...snapshot.translations.map((row) => `document-translation:${row.id}`)
    ])].sort();
    const locked = (index) => {
      if (index === keys.length || !globalThis.navigator?.locks?.request) return merge();
      return navigator.locks.request(keys[index], { ifAvailable: true }, (lock) => {
        if (!lock) throw new Error('另一窗口正在保存笔记、对话或全文翻译；请先暂停任务，再恢复备份。');
        return locked(index + 1);
      });
    };
    return locked(0);
  }
};

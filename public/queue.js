// Photo queue on the phone (IndexedDB). A photo stays here until the server confirms it.

const STORE = 'photos';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('rezanci', 2);
    r.onupgradeneeded = event => {
      // Version 1 was the test version with no upload. Its photos have no bag and cannot go to the archive.
      if (event.oldVersion === 1) r.result.deleteObjectStore(STORE);
      r.result.createObjectStore(STORE, { keyPath: 'sha' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Runs one request in one transaction. Resolves only after the transaction commits,
// so "saved" means the data is on the phone storage.
async function run(mode, request) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = request(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(r.result); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
}

export const put = record => run('readwrite', s => s.put(record));
export const all = () => run('readonly', s => s.getAll());
export const remove = sha => run('readwrite', s => s.delete(sha));

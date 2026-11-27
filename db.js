// Everything is stored inside the browser on this iPad (IndexedDB).
let opening;
function open() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('expobooth', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('files', { keyPath: 'id' });
      request.result.createObjectStore('contacts', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      request.result.onclose = () => { opening = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { opening = undefined; reject(request.error); };
  });
  return opening;
}

// Resolves only after the change is really written.
async function run(store, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Storage error'));
  });
}

export const get = (store, id) => run(store, 'readonly', s => s.get(id));
export const getAll = store => run(store, 'readonly', s => s.getAll());
export const put = (store, ...values) => run(store, 'readwrite', s => { values.forEach(v => s.put(v)); });
// Saves and deletes in one transaction: either everything happens or nothing.
export const change = (store, puts = [], deletes = []) => run(store, 'readwrite', s => {
  puts.forEach(v => s.put(v));
  deletes.forEach(id => s.delete(id));
});
export const remove = (store, id) => run(store, 'readwrite', s => { s.delete(id); });

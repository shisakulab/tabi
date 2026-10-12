// IndexedDB `tabigoyomi`：visits（場所の判子）/ seals（印）/ meals（体験）/ photos / settings
const NAME = 'tabigoyomi';
const STORES = ['visits', 'seals', 'meals', 'photos', 'settings'];
const VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        // 既にあるストアは触らない
        for (const s of STORES) {
          if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const get = (store, id) => run(store, 'readonly', (s) => s.get(id));
export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const remove = (store, id) => run(store, 'readwrite', (s) => s.delete(id));
export const clear = (store) => run(store, 'readwrite', (s) => s.clear());

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// 設定は { id: 'mode', value: 'walk' } の形で持つ
export async function getSetting(key, fallback = null) {
  const r = await get('settings', key);
  return r ? r.value : fallback;
}
export const setSetting = (key, value) => put('settings', { id: key, value });

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

const dataURLToBlob = async (url) => (await fetch(url)).blob();

// 写真を base64 で含めた1つの JSON
export async function exportAll() {
  const [visits, seals, meals, photos] = await Promise.all(['visits', 'seals', 'meals', 'photos'].map(getAll));
  const photoData = [];
  for (const p of photos) photoData.push({ id: p.id, data: await blobToDataURL(p.blob) });
  return { app: 'tabigoyomi', version: 1, exportedAt: new Date().toISOString(), visits, seals, meals, photos: photoData };
}

// 同じ id は上書き、それ以外は残す
export async function importAll(json) {
  if (!json || json.app !== 'tabigoyomi' || !Array.isArray(json.visits) || !Array.isArray(json.seals)) {
    throw new Error('旅暦のデータではありません');
  }
  for (const v of json.visits) await put('visits', v);
  for (const s of json.seals) await put('seals', s);
  for (const m of json.meals || []) await put('meals', m);
  for (const p of json.photos || []) {
    // 画像の data URL だけを受け付ける（それ以外の URL を読みに行かない）
    if (typeof p.data !== 'string' || !/^data:image\/(jpeg|png|webp|gif);base64,/.test(p.data)) continue;
    await put('photos', { id: p.id, blob: await dataURLToBlob(p.data) });
  }
}

export async function clearAll() {
  for (const s of STORES) await clear(s);
}

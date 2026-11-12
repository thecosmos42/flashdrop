const DB_NAME = 'dakar-buyer-secrets';
const STORE = 'secrets';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSecret(orderId: string, secret: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(secret, orderId);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadSecret(orderId: string): Promise<string | null> {
  const db = await openDatabase();
  const value = await new Promise<string | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(orderId);
    request.onsuccess = () => resolve((request.result as string | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close(); return value;
}

export async function newSecret(orderId: string): Promise<{secret: string; hash: string}> {
  const saved = await loadSecret(orderId);
  const bytes = saved ? Uint8Array.from(saved.match(/.{2}/g)!.map(x => parseInt(x,16))) : crypto.getRandomValues(new Uint8Array(32));
  const secret = saved ?? Array.from(bytes, x => x.toString(16).padStart(2,'0')).join('');
  if (!saved) await saveSecret(orderId, secret);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2,'0')).join('');
  return { secret, hash };
}

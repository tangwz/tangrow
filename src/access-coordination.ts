const deviceKey = 'tangrow:device:v1';
const activationKey = 'tangrow:activation:v1';
export const INTERACTIVE_TIMEOUT_MS = 15_000;

export interface AccessCoordination {
  initializeDevice(initialize: () => void): Promise<void>;
  tryActivate<T>(activate: () => Promise<T>): Promise<T | null>;
}

type Reservation = { owner: string; until: number };

/** Older WebViews can serialize short critical sections across windows with an IndexedDB writer. */
function transaction<T>(
  database: IDBFactory,
  operation: (reservation: Reservation | undefined, store: IDBObjectStore) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = database.open('tangrow:coordination:v1', 1);
    let blocked = false;
    open.onupgradeneeded = () => open.result.createObjectStore('locks');
    open.onerror = () => reject(open.error);
    open.onblocked = () => { blocked = true; reject(new Error('Device coordination is unavailable')); };
    open.onsuccess = () => {
      const db = open.result;
      if (blocked) { db.close(); return; }
      try {
        const tx = db.transaction('locks', 'readwrite');
        const store = tx.objectStore('locks');
        const read = store.get(activationKey);
        let result: T;
        read.onsuccess = () => {
          try { result = operation(read.result, store); }
          catch (error) { tx.abort(); reject(error); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error ?? new Error('Device coordination was interrupted'));
      } catch (error) { reject(error); }
      finally { db.close(); }
    };
  });
}

export function accessCoordination(win: Window): AccessCoordination {
  return {
    async initializeDevice(initialize) {
      const locks = win.navigator?.locks;
      if (locks) return locks.request(deviceKey, initialize);
      return transaction(win.indexedDB, initialize);
    },
    async tryActivate<T>(activate: () => Promise<T>) {
      const locks = win.navigator?.locks;
      if (locks) return locks.request(activationKey, { ifAvailable: true }, lock => lock ? activate() : null);

      // A crashed WebView cannot clear its reservation. Allow another attempt after the request deadline.
      const lifetime = 2 * INTERACTIVE_TIMEOUT_MS;
      const owner = Array.from(win.crypto.getRandomValues(new Uint32Array(4))).join('-');
      const clock = () => {
        const stamp = win.performance && win.performance.timeOrigin + win.performance.now();
        return Number.isFinite(stamp) ? stamp : Date.now();
      };
      const deadline = await transaction(win.indexedDB, (current, store) => {
        const now = clock();
        // Allow timestamp rounding across windows while recovering future-dated claims from a prior browser run.
        if (current && current.until > now && current.until <= now + 2 * lifetime) return null;
        const until = now + lifetime;
        store.put({ owner, until } satisfies Reservation, activationKey);
        return until;
      });
      if (deadline === null) return null;
      try { return clock() < deadline ? await activate() : null; }
      finally {
        // On a cleanup failure the bounded reservation still expires. Preserve the actual activation result.
        await transaction(win.indexedDB, (current, store) => {
          if (current?.owner === owner) store.delete(activationKey);
        }).catch(() => {});
      }
    },
  };
}

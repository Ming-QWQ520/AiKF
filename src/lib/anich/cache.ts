/**
 * 5-minute in-memory cache for Anich API responses (per-request key).
 * Works in both Tauri and browser modes. Entries expire after 5 minutes.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const TTL = 5 * 60 * 1000; // 5 minutes
const store = new Map<string, CacheEntry<unknown>>();

/** Get a cached value, or undefined if missing/expired. */
export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

/** Store a value with the 5-minute TTL. */
export function cacheSet<T>(key: string, value: T): void {
  store.set(key, { value, expiresAt: Date.now() + TTL });
}

/** Wrap an async function with caching. */
export function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return Promise.resolve(cached);
  return fn().then((v) => {
    cacheSet(key, v);
    return v;
  });
}

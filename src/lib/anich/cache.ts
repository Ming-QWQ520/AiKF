/**
 * 5-minute in-memory cache for Anich API responses (per-request key).
 * Works in both Tauri and browser modes. Entries expire after 5 minutes.
 *
 * 网络优化 — in-flight 去重：
 * 同一 key 的并发请求共享同一个 Promise（只发一次真实请求）。
 * 典型受益场景：搜索栏聚焦拉热榜 list(type=tv) 与首页热播榜同源；
 * 搜索栏实时搜索与搜索页提交搜索同 key —— 全部合并为一次请求。
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const TTL = 5 * 60 * 1000; // 5 minutes
const store = new Map<string, CacheEntry<unknown>>();
/** key -> 正在进行中的请求 Promise（完成后移除） */
const inflight = new Map<string, Promise<unknown>>();

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

/**
 * Wrap an async function with caching + in-flight request deduplication.
 * - 缓存命中：直接返回（零请求）
 * - 并发未命中：同 key 的所有调用共享同一 Promise，网络层只发一次
 * - 失败不缓存：错误传播给所有等待者，随后可立即重试
 */
export function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const p = (async () => {
    try {
      const v = await fn();
      cacheSet(key, v);
      return v;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

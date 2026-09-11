import { ref, computed, watch, type Ref } from "vue";

export interface UseAsyncOptions {
  /** When provided, the query only runs while this ref's value is truthy. */
  enabled?: Ref<unknown>;
  /** Run immediately on mount (default true). */
  immediate?: boolean;
  /** Max retries on error (default 2). */
  retries?: number;
  /** Retry delay in ms (default 1000). */
  retryDelay?: number;
}

export interface UseAsyncResult<T> {
  data: Ref<T | null>;
  error: Ref<Error | null>;
  isLoading: Ref<boolean>;
  isFetching: Ref<boolean>;
  isError: Ref<boolean>;
  refetch: () => Promise<void>;
}

/**
 * Minimal reactive async-data composable for the Anich views.
 * Re-runs whenever the `source` ref (or getter) changes, OR when `enabled`
 * transitions to truthy. Only runs while `enabled` (if provided) is truthy.
 *
 * Includes automatic retry logic (default 2 retries with 1s delay) since the
 * Anich API is occasionally slow/flaky.
 */
export function useAsync<T>(
  factory: () => Promise<T>,
  opts: UseAsyncOptions & { source?: Ref<unknown> | (() => unknown) } = {}
): UseAsyncResult<T> {
  const data = ref<T | null>(null) as Ref<T | null>;
  const error = ref<Error | null>(null);
  const isLoading = ref(false);
  const isFetching = ref(false);
  const isError = computed(() => error.value !== null);

  const enabled = opts.enabled ?? ref(true);
  const maxRetries = opts.retries ?? 2;
  const retryDelay = opts.retryDelay ?? 1000;
  let firstRun = true;

  const runWithRetry = async (): Promise<T> => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await factory();
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  };

  const run = async () => {
    if (!enabled.value) return;
    if (firstRun) isLoading.value = true;
    isFetching.value = true;
    try {
      const result = await runWithRetry();
      data.value = result as T;
      error.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e));
      if (firstRun) data.value = null;
    } finally {
      isLoading.value = false;
      isFetching.value = false;
      firstRun = false;
    }
  };

  // Track an internal "last-run signature" so we re-run when enabled flips to
  // true even if the source value hasn't changed.
  const sourceGetter = opts.source !== undefined
    ? (typeof opts.source === "function" ? opts.source : () => (opts.source as Ref<unknown>).value)
    : null;

  // Combined watch: re-run on source change OR enabled change.
  watch(
    () => ({ src: sourceGetter ? sourceGetter() : null, en: enabled.value }),
    (n, o) => {
      // Only run if enabled is truthy. If source changed OR enabled just became truthy, run.
      if (enabled.value && (n.src !== o?.src || n.en !== o?.en)) run();
    },
    { immediate: opts.immediate !== false }
  );

  return { data, error, isLoading, isFetching, isError, refetch: run };
}

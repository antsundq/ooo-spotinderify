export type Rng = () => number;

export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Picks one item with probability proportional to its weight. */
export function weightedPick<T>(items: readonly T[], weight: (t: T) => number, rng: Rng = Math.random): T | undefined {
  const total = items.reduce((sum, t) => sum + Math.max(0, weight(t)), 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let r = rng() * total;
  for (const t of items) {
    r -= Math.max(0, weight(t));
    if (r < 0) return t;
  }
  return items[items.length - 1];
}

/** `Promise.all(items.map(fn))` with at most `limit` calls in flight, to stay under rate limits. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Runs `fn` and returns undefined instead of throwing, logging the error. Quota errors are rethrown. */
export async function tryOrSkip<R>(fn: () => Promise<R>, isFatal: (e: unknown) => boolean): Promise<R | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isFatal(err)) throw err;
    console.warn(err);
    return undefined;
  }
}

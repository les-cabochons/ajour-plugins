// Keeps the plugin's requests under a rate limit, such as the Forwarder's 10
// requests a second with a burst of 20, by waiting before a request that
// would pass it. It is a token bucket like the Forwarder's own, used by one
// caller at a time.

export interface PacerOptions {
  /** Requests that may go at once after a quiet moment. */
  burst: number;
  /** Requests a second after the burst. */
  perSecond: number;
  /** A monotonic clock in milliseconds. `performance.now` by default, which a test's fake Date does not stop. */
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Returns `pace`, to await before each request. */
export function createPacer({
  burst,
  perSecond,
  now = () => performance.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: PacerOptions) {
  let tokens = burst;
  let refilledAt = now();
  return async function pace() {
    const current = now();
    tokens = Math.min(burst, tokens + ((current - refilledAt) / 1000) * perSecond);
    refilledAt = current;
    if (tokens < 1) {
      await sleep(((1 - tokens) / perSecond) * 1000);
      // The wait earned exactly the missing part of one token.
      tokens = 1;
      refilledAt = now();
    }
    tokens -= 1;
  };
}

export interface RetryOptions {
  attempts: number;
  backoffMs: number[];
  retryable: (err: unknown) => boolean;
  delayOverride?: (err: unknown, attempt: number) => number | null;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= opts.attempts || !opts.retryable(err)) throw err;
      const baseDelay =
        opts.backoffMs[attempt - 1] ??
        opts.backoffMs[opts.backoffMs.length - 1];
      const override = opts.delayOverride?.(err, attempt);
      const delay = override != null ? override : baseDelay;
      opts.onRetry?.(err, attempt, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../../src/util/retry";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the function exactly once when it succeeds on the first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, {
      attempts: 3,
      backoffMs: [10, 20],
      retryable: () => true,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once and succeeds on the second attempt after a transient failure", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue("ok");

    const promise = withRetry(fn, {
      attempts: 3,
      backoffMs: [10, 20],
      retryable: () => true,
    });

    // Allow the first rejection to settle, then advance past the backoff delay.
    await vi.advanceTimersByTimeAsync(10);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows the final error after exhausting all attempts on transient errors", async () => {
    const err = new Error("always transient");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, {
      attempts: 3,
      backoffMs: [10, 20],
      retryable: () => true,
    });

    // Attach the rejection handler synchronously so the unhandled rejection
    // doesn't fire while we're advancing timers.
    const assertion = expect(promise).rejects.toThrow("always transient");

    // Drain both backoff waits.
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("fails immediately on non-transient errors with no retries", async () => {
    const err = new Error("permanent");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, {
        attempts: 5,
        backoffMs: [10, 20, 30, 40],
        retryable: () => false,
      }),
    ).rejects.toThrow("permanent");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honors delayOverride callback for the retry delay", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("first")).mockResolvedValue("done");

    const onRetry = vi.fn();
    const promise = withRetry(fn, {
      attempts: 3,
      backoffMs: [10, 20],
      retryable: () => true,
      delayOverride: () => 500,
      onRetry,
    });

    // Less than the override delay should not retry yet.
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);

    // Advance past the override.
    await vi.advanceTimersByTimeAsync(400);

    const result = await promise;
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 500);
  });

  it("waits the configured backoff between retries (per-attempt timing)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockResolvedValue("ok");

    const onRetry = vi.fn();
    const promise = withRetry(fn, {
      attempts: 3,
      backoffMs: [100, 300],
      retryable: () => true,
      onRetry,
    });

    // After first failure, less than the first backoff: no second call yet.
    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(1);

    // Cross the first backoff boundary: second attempt fires.
    await vi.advanceTimersByTimeAsync(60);
    expect(fn).toHaveBeenCalledTimes(2);

    // Less than the second backoff: still 2 calls.
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(2);

    // Cross the second backoff boundary: third attempt fires and resolves.
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.any(Error), 1, 100);
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.any(Error), 2, 300);
  });
});

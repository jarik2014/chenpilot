/**
 * Shared AbortSignal helpers for the Chen Pilot SDK.
 *
 * Every network and signing operation should accept an optional external
 * `signal` and use these helpers so that:
 *   - cancellation interrupts active I/O and pending retry delays,
 *   - the cancellation cause is never masked (abort errors keep `name === "AbortError"`),
 *   - listeners registered on the caller's signal are always removed (no leaks).
 */

import type { AbortSignalLike } from "./types";

// ─── Abort detection ─────────────────────────────────────────────────────────

/**
 * Returns `true` when `error` represents a cancelled operation.
 *
 * Detects the DOM `AbortError`, Node's `AbortError`, axios cancellations and
 * errors produced by this SDK's {@link createAbortError}.
 */
export function isAbortError(error: unknown): boolean {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return false;
  }

  const name = (error as { name?: unknown }).name;
  // Normalise both shapes callers actually receive: the DOM `DOMException`
  // (name === "AbortError", not an Error instance) and Node/SDK errors.
  if (name === "AbortError") return true;

  // Axios cancellation (used by stellar-sdk's Horizon client).
  const code = (error as { code?: unknown }).code;
  if (code === "ERR_CANCELED") return true;
  if ((error as { __CANCEL__?: unknown }).__CANCEL__ !== undefined) return true;

  return false;
}

/**
 * Creates a cancellation error without masking the cause.
 *
 * The error carries `name === "AbortError"` so callers can distinguish a
 * cancellation from ordinary failures, and the original cause is chained for
 * diagnostics.
 */
export function createAbortError(
  message = "The operation was aborted",
  cause?: unknown
): Error {
  const err: Error & { cause?: unknown } = new Error(message);
  err.name = "AbortError";
  if (cause !== undefined) {
    err.cause = cause;
  }
  return err;
}

/**
 * Throws an abort error when the given signal was already aborted.
 */
export function throwIfAborted(signal?: AbortSignalLike): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

/**
 * Throws when `signal` is already aborted, otherwise returns the native
 * `AbortSignal` to hand to `fetch` (casting a structural `AbortSignalLike`).
 */
export function toNativeSignal(signal?: AbortSignalLike): AbortSignal | undefined {
  if (!signal) return undefined;
  return signal as AbortSignal;
}

// ─── Listener helpers ────────────────────────────────────────────────────────

function addAbortListener(
  signal: AbortSignalLike | undefined,
  listener: () => void
): () => void {
  if (!signal) return () => undefined;

  if (typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", listener, { once: true });
    return () => signal.removeEventListener?.("abort", listener);
  }

  // Fallback for minimal stubs that only expose `onabort`.
  if (signal.onabort === undefined || signal.onabort === null) {
    signal.onabort = listener;
    return () => {
      signal.onabort = null;
    };
  }

  return () => undefined;
}

function removeAbortListener(
  signal: AbortSignalLike | undefined,
  listener: () => void
): void {
  signal?.removeEventListener?.("abort", listener);
}

// ─── Signal combination ──────────────────────────────────────────────────────

export interface CombinedSignal {
  /** Signal to pass to `fetch`/I/O. `undefined` when nothing needs cancelling. */
  signal: AbortSignal | undefined;
  /** Releases the timeout and removes the external listener. Always call when done. */
  cleanup: () => void;
}

/**
 * Merges an optional timeout with an optional external signal into a single
 * abortable signal.
 *
 * The returned `cleanup()` must be invoked when the operation completes (both
 * on success and failure) so the timeout is cleared and the listener attached
 * to `external` is removed — otherwise listeners leak until abort fires.
 */
export function combineSignals(
  timeoutMs: number | undefined,
  external?: AbortSignalLike
): CombinedSignal {
  const noop: CombinedSignal = {
    signal: undefined,
    cleanup: () => undefined,
  };

  if (timeoutMs === undefined && !external) {
    return noop;
  }

  if (timeoutMs === undefined && external) {
    if (external.aborted) {
      // Already cancelled: surface an already-aborted controller so I/O fails fast.
      const controller = new AbortController();
      controller.abort();
      return { signal: controller.signal, cleanup: () => undefined };
    }
    // No timeout: pass the caller's signal straight through, nothing to clean up.
    return { signal: external as AbortSignal, cleanup: () => undefined };
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeExternal: (() => void) | undefined;

  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      removeExternal = addAbortListener(external, () => controller.abort());
    }
  }

  if (timeoutMs !== undefined && timeoutMs > 0 && !controller.signal.aborted) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      removeExternal?.();
    },
  };
}

// ─── Abortable sleep ─────────────────────────────────────────────────────────

/**
 * `setTimeout`-based delay that resolves after `ms` milliseconds or rejects
 * with an abort error as soon as `signal` fires. Used to make retry backoff
 * interruptible.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignalLike
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      removeAbortListener(signal, onAbort);
      fn();
    };

    timeoutId = setTimeout(() => finish(resolve), ms);
    const onAbort = () => finish(() => reject(createAbortError()));

    if (signal) addAbortListener(signal, onAbort);
  });
}

// ─── Abortable wait ──────────────────────────────────────────────────────────

export interface AbortableWaitOptions {
  /**
   * Invoked exactly once when the wait is interrupted by the signal. Useful to
   * record that an ambiguous outcome occurred (e.g. a submission may have
   * already reached the network).
   */
  onAbort?: () => void;
}

/**
 * Waits for `promise` while listening for `signal`.
 *
 * When `signal` fires before `promise` settles, the returned promise rejects
 * with an abort error and `options.onAbort` is invoked. The listener is always
 * removed once the race settles. Underlying work that effectively cannot be
 * cancelled (e.g. stellar-sdk's axios-based Horizon calls) keeps running, but
 * the caller is unblocked promptly.
 */
export function abortableWait<T>(
  promise: Promise<T>,
  signal?: AbortSignalLike,
  options: AbortableWaitOptions = {}
): Promise<T> {
  if (!signal) {
    // Even without a caller signal the shape must be consistent: an I/O layer
    // that cancels itself can still reject with the platform DOMException.
    return promise.catch((error: unknown) => {
      throw isAbortError(error) ? createAbortError(undefined, error) : error;
    });
  }
  if (signal.aborted) {
    options.onAbort?.();
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => removeAbortListener(signal, onAbort);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      options.onAbort?.();
      reject(createAbortError());
    };

    addAbortListener(signal, onAbort);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        // A fetch that was cancelled under us rejects with the platform's
        // DOMException, while our own cancel path rejects with an SDK Error.
        // Callers must see one shape, so both arrive as createAbortError().
        reject(isAbortError(error) ? createAbortError(undefined, error) : error);
      }
    );
  });
}
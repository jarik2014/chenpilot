import {
  abortableWait,
  createAbortError,
  isAbortError,
  throwIfAborted,
} from '../abort';

/**
 * #1048 — every cancellation must reach the caller as one shape: an `Error`
 * with `name === "AbortError"`. The SDK's own cancel path already did that, but
 * a fetch cancelled underneath it rejects with the platform's `DOMException`,
 * and `instanceof Error` is false for those, so callers that branched on
 * `error instanceof Error` silently took the wrong path.
 */
describe('abort contract (#1048)', () => {
  it('rejects before dispatch when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const call = jest.fn(async () => 'never called');

    await expect(abortableWait(call(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not await the underlying promise when aborted up front', async () => {
    const controller = new AbortController();
    controller.abort();
    let resolved = false;
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve('late');
      }, 20);
    });

    await expect(abortableWait(slow, controller.signal)).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
    expect(resolved).toBe(false);
  });

  it('rejects during flight, and the late result is dropped', async () => {
    const controller = new AbortController();
    let resolved = false;
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve('late');
      }, 30);
    });

    const pending = abortableWait(slow, controller.signal);
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await new Promise((r) => setTimeout(r, 40));
    expect(resolved).toBe(true); // the promise finished…
  });

  it('normalises a platform DOMException abort to the SDK shape', async () => {
    const domAbort = new DOMException('The operation was aborted', 'AbortError');
    const failing = Promise.reject(domAbort);

    const error = await abortableWait(failing).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AbortError');
    expect(error.cause).toBe(domAbort);
  });

  it('leaves ordinary failures untouched', async () => {
    const boom = new Error('network down');
    const failing = Promise.reject(boom);

    await expect(abortableWait(failing)).rejects.toBe(boom);
  });

  it('recognises DOMException, axios cancellation and SDK errors alike', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(createAbortError())).toBe(true);
    expect(isAbortError({ code: 'ERR_CANCELED' })).toBe(true);
    expect(isAbortError(new Error('other'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it('throwIfAborted throws the same shape everywhere', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it('passes the signal through untouched when it never aborts', async () => {
    const controller = new AbortController();
    await expect(abortableWait(Promise.resolve(42), controller.signal)).resolves.toBe(42);
  });
});

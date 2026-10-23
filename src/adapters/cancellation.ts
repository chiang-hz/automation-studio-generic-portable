/** Cancel only this download context, never its shared Browser instance. */
export function bindContextCancellation(context: { close(): Promise<void> }, signal?: AbortSignal): () => Promise<void> {
  let closing: Promise<void> | undefined;
  const close = () => closing ??= context.close().catch(() => undefined);
  const abort = () => { void close(); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return async () => {
    signal?.removeEventListener("abort", abort);
    await close();
  };
}

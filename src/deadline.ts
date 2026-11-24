/**
 * Runs `work` under a deadline this call owns. `work` receives a signal that
 * aborts at the deadline, and the call rejects with a `TimeoutError` naming
 * `operation` at the deadline even when `work` ignores the abort.
 *
 * The rejection does not depend on the signal: once a response's headers
 * arrive, fetch's abort listener can be garbage-collected while a body read is
 * pending, and then aborting stops nothing.
 */
export async function withDeadline<T>(
  operation: string,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const reason = new DOMException(`${operation} timed out after ${timeoutMs}ms`, 'TimeoutError')
      controller.abort(reason)
      reject(reason)
    }, timeoutMs)
  })
  try {
    return await Promise.race([work(controller.signal), expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Whether `error` is a deadline's rejection, or an abort it caused. */
export function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

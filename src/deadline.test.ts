import { describe, expect, test } from 'vitest'

import { isTimeout, withDeadline } from './deadline.js'

describe('withDeadline', () => {
  test('rejects at the deadline even when the work ignores the abort', async () => {
    let received: AbortSignal | undefined
    const stalled = withDeadline('Reading a stalled body', 20, (signal) => {
      received = signal
      return new Promise<never>(() => {})
    })
    const error: unknown = await stalled.catch((caught: unknown) => caught)
    expect(isTimeout(error)).toBe(true)
    expect(error).toMatchObject({ message: 'Reading a stalled body timed out after 20ms' })
    expect(received?.aborted).toBe(true)
  })

  test('returns the work and leaves its signal unaborted when it finishes in time', async () => {
    let received: AbortSignal | undefined
    const value = await withDeadline('A quick call', 1_000, async (signal) => {
      received = signal
      return 'done'
    })
    expect(value).toBe('done')
    expect(received?.aborted).toBe(false)
  })
})

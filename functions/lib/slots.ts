/**
 * Shared outbound in-flight limiter. One limiter per request, across engines.
 * Six slots matches the Workers simultaneous-connection cap, so a later build
 * can reuse this instead of letting extra fetches queue inside `fetch`.
 *
 * `t_queued` is when the call asked for a slot. `t_slot` is when it got one.
 * The AbortController starts at `t_slot`, not while the call is waiting.
 * Release in a `finally` block, including throw and abort.
 * Read a 2xx body immediately, or `body.cancel()` on non-2xx, parse failure, and abort.
 */

export const OUTBOUND_SLOT_LIMIT = 6

export type HeldSlot = {
  t_queued: number
  t_slot: number
  signal: AbortSignal
}

export type OutboundSlots = {
  readonly limit: number
  inFlight(): number
  /**
   * Wait for a slot, then start `timeoutMs`. `fn` may fetch more than once
   * (a single retry) on the same signal. The slot is released when `fn` settles.
   */
  use<T>(
    opts: { timeoutMs: number; now: () => number; parent?: AbortSignal },
    fn: (slot: HeldSlot) => Promise<T>,
  ): Promise<T>
}

type Waiter = () => void

export function createOutboundSlots(limit = OUTBOUND_SLOT_LIMIT): OutboundSlots {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('slot limit must be a positive integer')
  let active = 0
  const waiting: Waiter[] = []

  const release = () => {
    active -= 1
    const next = waiting.shift()
    if (next) next()
  }

  const acquire = () =>
    new Promise<void>((resolve) => {
      const grant = () => {
        active += 1
        resolve()
      }
      if (active < limit) grant()
      else waiting.push(grant)
    })

  return {
    limit,
    inFlight: () => active,
    async use(opts, fn) {
      const t_queued = opts.now()
      await acquire()
      const t_slot = opts.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
      const onParent = () => controller.abort()
      if (opts.parent) {
        if (opts.parent.aborted) controller.abort()
        else opts.parent.addEventListener('abort', onParent, { once: true })
      }
      let released = false
      const finish = () => {
        if (released) return
        released = true
        clearTimeout(timer)
        opts.parent?.removeEventListener('abort', onParent)
        release()
      }
      try {
        return await fn({ t_queued, t_slot, signal: controller.signal })
      } finally {
        finish()
      }
    },
  }
}

/** `body.cancel()`. Safe when the body is already consumed or missing. */
export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Already closed, aborted, or never present.
  }
}

/**
 * Read JSON from a 2xx body, or cancel without reading.
 * A parse failure cancels whatever is left. The cancel also runs after a successful read.
 */
export async function settleResponseBody(response: Response, read: boolean): Promise<unknown | null> {
  try {
    if (!read || !response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    await cancelResponseBody(response)
  }
}

export type SlotFetch = {
  response: Response | null
  payload: unknown | null
  timedOut: boolean
  t_queued: number
  t_slot: number
  t_start: number
  t_headers: number | null
  t_end: number
}

/**
 * One fetch under the limiter. The timeout starts at `t_slot`.
 * The body is read or cancelled before the slot is released.
 */
export async function fetchInSlot(
  slots: OutboundSlots,
  opts: {
    timeoutMs: number
    now: () => number
    parent?: AbortSignal
    url: string
    method?: string
    headers?: HeadersInit
    body?: string
  },
): Promise<SlotFetch> {
  return slots.use({ timeoutMs: opts.timeoutMs, now: opts.now, parent: opts.parent }, async (slot) => {
    const t_start = opts.now()
    try {
      const response = await fetch(opts.url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: slot.signal,
      })
      const t_headers = opts.now()
      const payload = await settleResponseBody(response, response.ok)
      return {
        response,
        payload,
        timedOut: false,
        t_queued: slot.t_queued,
        t_slot: slot.t_slot,
        t_start,
        t_headers,
        t_end: opts.now(),
      }
    } catch {
      return {
        response: null,
        payload: null,
        timedOut: true,
        t_queued: slot.t_queued,
        t_slot: slot.t_slot,
        t_start,
        t_headers: null,
        t_end: opts.now(),
      }
    }
  })
}

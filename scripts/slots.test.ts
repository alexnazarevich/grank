/**
 * Shared outbound slot limiter. At most `limit` calls run at once.
 * The timeout starts when a slot is granted, and the slot is released on
 * success, throw, and abort. A non-2xx body is cancelled before release.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cancelResponseBody, createOutboundSlots, fetchInSlot, OUTBOUND_SLOT_LIMIT } from '../functions/lib/slots.ts'

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('outbound slots', () => {
  it('never runs more than 6 calls at once', async () => {
    const slots = createOutboundSlots()
    assert.equal(slots.limit, OUTBOUND_SLOT_LIMIT)
    let current = 0
    let max = 0
    const tasks = Array.from({ length: 14 }, () =>
      slots.use({ timeoutMs: 2_000, now: () => Date.now() }, async () => {
        current += 1
        max = Math.max(max, current, slots.inFlight())
        await delay(30)
        current -= 1
      }),
    )
    await Promise.all(tasks)
    assert.equal(max, 6)
    assert.equal(slots.inFlight(), 0)
  })

  it('releases the slot when the call throws', async () => {
    const slots = createOutboundSlots(1)
    await assert.rejects(
      () => slots.use({ timeoutMs: 1_000, now: () => 0 }, async () => {
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.equal(slots.inFlight(), 0)
    let ran = false
    await slots.use({ timeoutMs: 1_000, now: () => 0 }, async () => {
      ran = true
    })
    assert.equal(ran, true)
    assert.equal(slots.inFlight(), 0)
  })

  it('releases the slot when the call aborts and does not start the timeout while queued', async () => {
    const slots = createOutboundSlots(1)
    await assert.rejects(
      () =>
        slots.use({ timeoutMs: 20, now: () => Date.now() }, async (slot) => {
          await new Promise((_resolve, reject) => {
            slot.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }),
      /aborted/,
    )
    assert.equal(slots.inFlight(), 0)

    let clock = 0
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const queued = createOutboundSlots(1)
    const first = queued.use({ timeoutMs: 5_000, now: () => clock }, () => gate)
    const second = queued.use({ timeoutMs: 15, now: () => clock }, (slot) => ({
      aborted: slot.signal.aborted,
      t_queued: slot.t_queued,
      t_slot: slot.t_slot,
    }))
    await delay(40)
    clock = 80
    releaseFirst()
    const got = await second
    await first
    assert.equal(got.aborted, false)
    assert.equal(got.t_queued, 0)
    assert.equal(got.t_slot, 80)
    assert.equal(queued.inFlight(), 0)
  })

  it('cancels the body on a non-2xx response and on a thrown fetch', async () => {
    const prev = globalThis.fetch
    try {
      let cancelled = false
      globalThis.fetch = (async () => {
        const response = new Response('nope', { status: 502 })
        const body = response.body
        assert.ok(body)
        const cancel = body.cancel.bind(body)
        body.cancel = async (reason) => {
          cancelled = true
          return cancel(reason)
        }
        return response
      }) as typeof fetch
      const slots = createOutboundSlots(1)
      const failed = await fetchInSlot(slots, { timeoutMs: 1_000, now: () => Date.now(), url: 'https://example.test/fail' })
      assert.equal(failed.timedOut, false)
      assert.equal(failed.response?.status, 502)
      assert.equal(failed.payload, null)
      assert.equal(cancelled, true)
      assert.equal(slots.inFlight(), 0)

      globalThis.fetch = (async () => {
        throw new Error('socket')
      }) as typeof fetch
      const thrown = await fetchInSlot(slots, { timeoutMs: 1_000, now: () => Date.now(), url: 'https://example.test/throw' })
      assert.equal(thrown.timedOut, true)
      assert.equal(thrown.response, null)
      assert.equal(slots.inFlight(), 0)

      const loose = new Response('left open', { status: 500 })
      let looseCancelled = false
      assert.ok(loose.body)
      const looseCancel = loose.body.cancel.bind(loose.body)
      loose.body.cancel = async (reason) => {
        looseCancelled = true
        return looseCancel(reason)
      }
      await cancelResponseBody(loose)
      assert.equal(looseCancelled, true)
    } finally {
      globalThis.fetch = prev
    }
  })
})

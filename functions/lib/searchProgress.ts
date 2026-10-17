/**
 * Tell the signed-in Run again screen when searched calls have settled.
 * One ndjson line `{searches:'done'}` is written as soon as they finish or miss.
 * The report JSON follows on the next line. Callers that omit the progress header
 * still get a single JSON response.
 */

export function settleSearches<T>(task: Promise<T>, onSettled?: () => void): Promise<T> {
  let noted = false
  const note = () => {
    if (noted) return
    noted = true
    onSettled?.()
  }
  return task.then(
    (value) => {
      note()
      return value
    },
    (err: unknown) => {
      note()
      throw err
    },
  )
}

export function wantsSearchProgress(request: Request): boolean {
  return request.headers.get('x-grank-search-progress') === '1'
}

/** Run the report, emitting `{searches:'done'}` when that callback fires, then `{status, body}`. */
export function ownedReportProgressStream(run: (onSearchesSettled: () => void) => Promise<Response>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (value: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
      }
      try {
        const response = await run(() => emit({ searches: 'done' }))
        const text = await response.text()
        let body: unknown = null
        if (text) {
          try {
            body = JSON.parse(text)
          } catch {
            body = { error: 'Could not build the full report.' }
          }
        }
        emit({ status: response.status, body })
      } catch {
        emit({ status: 502, body: { error: 'Could not build the full report.' } })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * GET /api/product-config
 * Non-secret knobs for the UI. Enforcement still reads env inside each Function.
 */

import { productConfigFromEnv } from '../../src/config/productConfig.ts'
import { json } from './http.ts'

export async function onRequest(context: {
  request: Request
  env?: Record<string, string | undefined>
}): Promise<Response> {
  if (context.request.method !== 'GET') return json(405, { error: 'Use GET' })
  return json(200, { ok: true, config: productConfigFromEnv(context.env) })
}

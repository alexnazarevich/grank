/**
 * Pages Cron scaffold for tracked re-runs (bet 13).
 *
 * Do not attach a Cloudflare Pages Cron Trigger. This file does not export
 * onRequest, so it is not an HTTP route. onScheduled does not call OpenAI,
 * does not write checks, and does not read a cron secret.
 *
 * TRACKING_CADENCE is stored for later and unused. TRACKING_CRON_ENABLED
 * stays false until Alex enables schedules.
 */

import { productConfigFromEnv } from '../src/config/productConfig.ts'

export type ScheduledTrackingResult = {
  ran: false
  reason: 'tracking_cron_disabled' | 'tracking_cron_scaffold'
  cadence?: string
}

export async function onScheduled(
  context: { env?: Record<string, string | undefined>; cron?: string } = {},
): Promise<ScheduledTrackingResult> {
  const config = productConfigFromEnv(context.env)
  if (!config.trackingCronEnabled) {
    return { ran: false, reason: 'tracking_cron_disabled' }
  }
  return { ran: false, reason: 'tracking_cron_scaffold', cadence: config.trackingCadence }
}

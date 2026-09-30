/**
 * Pages Cron scaffold for tracked re-runs (bet 13).
 *
 * No cron trigger is registered. This file does not export onRequest, so it is
 * not an HTTP route. onScheduled does not call OpenAI and does not write checks.
 *
 * Later, when Alex turns schedules on: set TRACKING_CRON_ENABLED=true and add a
 * Pages Cron Trigger that invokes this function. Until then the handler returns
 * before any re-run, including when the flag is accidentally set.
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

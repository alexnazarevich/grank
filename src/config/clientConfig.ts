import { mergeProductConfig, parseConfigJson, PRODUCT_DEFAULTS, type ProductConfig } from './productConfig.ts'

function viteValue(name: string): string {
  const env = import.meta.env as Record<string, string | undefined> | undefined
  if (!env) return ''
  const value = env[name]
  return typeof value === 'string' ? value : ''
}

/** UI config: defaults merged with optional VITE_PRODUCT_CONFIG_JSON. Not used for enforcement. */
export function clientProductConfig(): ProductConfig {
  return mergeProductConfig(PRODUCT_DEFAULTS, parseConfigJson(viteValue('VITE_PRODUCT_CONFIG_JSON')))
}

/** Prefer the Pages Function (server knobs). Fall back to the Vite mirror when it is down. */
export async function loadProductConfig(): Promise<ProductConfig> {
  const fallback = clientProductConfig()
  try {
    const res = await fetch('/api/product-config', { headers: { Accept: 'application/json' } })
    const type = res.headers.get('content-type') || ''
    if (!res.ok || !type.includes('application/json')) return fallback
    const data = (await res.json()) as { config?: unknown }
    return mergeProductConfig(PRODUCT_DEFAULTS, data.config ?? null)
  } catch {
    return fallback
  }
}

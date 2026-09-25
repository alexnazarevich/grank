/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_PRODUCT_CONFIG_JSON?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

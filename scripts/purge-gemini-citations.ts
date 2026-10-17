/**
 * One-step purge of Gemini citations.
 * Deletes every engine='gemini' source and stored Search Suggestions.
 * Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment.
 * Safe to run again: a second run deletes nothing.
 */
import { purgeGeminiCitations } from '../functions/api/citations.ts'

const result = await purgeGeminiCitations({
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
})
console.log(`deleted ${result.sources} citation sources`)
console.log(`deleted ${result.suggestions} search suggestions`)

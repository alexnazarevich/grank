/**
 * One-step purge of Gemini citations stored on saved checks.
 * Pages through checks and removes every engine='gemini' source and its Search Suggestions.
 * Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment.
 * Safe to run again: a second run changes nothing.
 */
import { purgeGeminiCitations } from '../functions/api/citations.ts'

const result = await purgeGeminiCitations({
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
})
console.log(`changed ${result.rows} rows`)
console.log(`removed ${result.sources} sources`)

import "server-only";

export function getTokenEncryptionKey(): string {
  const key = process.env["TOKEN_ENCRYPTION_KEY"];

  if (typeof key !== "string" || !key) {
    throw new Error("TOKEN_ENCRYPTION_KEY is missing");
  }
  return key;
}

export function getSupabaseServerKey(): string {
  const key = process.env["SUPABASE_SECRET_KEY"] ?? process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (typeof key !== "string" || !key) {
    throw new Error("Supabase server key is missing");
  }
  return key;
}

export function getGoogleOAuthCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth server credentials are missing");
  }
  return { clientId, clientSecret };
}

export function getCronSecret(): string {
  const secret = process.env["CRON_SECRET"];
  if (!secret) throw new Error("CRON_SECRET is missing");
  return secret;
}

/**
 * Separate from CRON_SECRET (which authenticates Vercel's own once-daily
 * Hobby-plan cron and this app's self-continuation calls). Hobby plans
 * cannot run a Vercel Cron more often than once per day, so delayed job
 * retries (Gemini 503 backoff etc.) need a different trigger: Supabase's
 * own pg_cron + pg_net call /api/cron/jobs every few minutes, entirely
 * within the already-provisioned Supabase project (no new paid service).
 * This secret is generated inside Postgres itself (encode(gen_random_
 * bytes(32),'hex')) and stored in Supabase Vault - see the phase3_job_
 * bridge_cron migration - never typed or guessed by a human/agent.
 */
export function getSupabaseCronBridgeSecret(): string {
  const secret = process.env["SUPABASE_CRON_BRIDGE_SECRET"];
  if (!secret) throw new Error("SUPABASE_CRON_BRIDGE_SECRET is missing");
  return secret;
}

export type GeminiStage = "research" | "generation";

/**
 * Stage-specific model selection, not one shared model. gemini-2.5-flash
 * AND gemini-2.5-flash-lite are both retired for new users (confirmed live
 * via real 404s - "This model ... is no longer available to new users.
 * Please update your code to use models/gemini-3.5-flash-lite"). STEP A
 * (Research) needs Google Search grounding; gemini-3.5-flash-lite is a
 * valid, reachable model for it, though this account currently hits a 429
 * quota/billing limit specifically on grounding (see
 * lib/gemini/client.ts's researchClinic - it falls back to DEGRADED mode
 * when grounding is unavailable, rather than failing outright). STEP B/C
 * (Preparation/Material) don't use grounding and use the confirmed-working
 * GA stable model. GEMINI_RESEARCH_MODEL / GEMINI_GENERATION_MODEL take
 * priority; the legacy GEMINI_MODEL (if still set) is a backward-compatible
 * fallback, then these hardcoded defaults.
 */
const GEMINI_STAGE_DEFAULT_MODEL: Record<GeminiStage, string> = {
  research: "gemini-3.5-flash-lite",
  generation: "gemini-3.8-flash",
};

const GEMINI_STAGE_ENV_KEY: Record<GeminiStage, string> = {
  research: "GEMINI_RESEARCH_MODEL",
  generation: "GEMINI_GENERATION_MODEL",
};

export function getGeminiCredentials(stage: GeminiStage): { apiKey: string; model: string } {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  const model = process.env[GEMINI_STAGE_ENV_KEY[stage]]
    || process.env["GEMINI_MODEL"]
    || GEMINI_STAGE_DEFAULT_MODEL[stage];

  return { apiKey, model };
}

export function hasGeminiCredentials(): boolean {
  return Boolean(process.env["GEMINI_API_KEY"]);
}

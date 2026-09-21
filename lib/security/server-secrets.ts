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

/**
 * After this many attempts of the SAME job keep failing, the
 * generation-stage call switches to a separately-configured fallback model
 * rather than continuing to hammer the primary one. In practice this only
 * engages for persistent transient/capacity failures (503 "high demand"):
 * a configuration error (404) short-circuits to FAILED on its very first
 * attempt (see GeminiApiError.isConfigurationError) without ever reaching
 * this threshold, so attempt count alone is a safe, simple proxy without
 * needing to thread specific error classifications down from the job
 * processor. Applies to Preparation, Material, and the Research Agent's own
 * DEGRADED fallback - all three resolve credentials via the "generation"
 * stage.
 */
const GENERATION_FALLBACK_AFTER_ATTEMPTS = 3;
const GEMINI_GENERATION_FALLBACK_DEFAULT_MODEL = "gemini-3.5-flash-lite";

export function getGeminiCredentials(
  stage: GeminiStage,
  options?: { attempts?: number },
): { apiKey: string; model: string } {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

  if (stage === "generation" && (options?.attempts ?? 0) >= GENERATION_FALLBACK_AFTER_ATTEMPTS) {
    const fallbackModel = process.env["GEMINI_GENERATION_FALLBACK_MODEL"] || GEMINI_GENERATION_FALLBACK_DEFAULT_MODEL;
    return { apiKey, model: fallbackModel };
  }

  const model = process.env[GEMINI_STAGE_ENV_KEY[stage]]
    || process.env["GEMINI_MODEL"]
    || GEMINI_STAGE_DEFAULT_MODEL[stage];

  return { apiKey, model };
}

export function hasGeminiCredentials(): boolean {
  return Boolean(process.env["GEMINI_API_KEY"]);
}

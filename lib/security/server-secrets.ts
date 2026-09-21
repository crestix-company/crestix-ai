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
 * Stage-specific model selection, not one shared model: gemini-2.5-flash
 * was retired for new users (confirmed live via a real 404 - "This model
 * models/gemini-2.5-flash is no longer available to new users"), and its
 * replacement isn't one-size-fits-all. STEP A (Research) needs Google
 * Search grounding, which on the free tier is only available on specific
 * models (gemini-2.5-flash-lite) - Gemini 3.x grounding is not available
 * on the free tier at all. STEP B/C (Preparation/Material) don't use
 * grounding and can use the current GA stable model for output quality.
 * GEMINI_RESEARCH_MODEL / GEMINI_GENERATION_MODEL take priority; the
 * legacy GEMINI_MODEL (if still set) is a backward-compatible fallback,
 * then these hardcoded defaults.
 */
const GEMINI_STAGE_DEFAULT_MODEL: Record<GeminiStage, string> = {
  research: "gemini-2.5-flash-lite",
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

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

export function getGeminiCredentials(): { apiKey: string; model: string } {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");
  return { apiKey, model: process.env["GEMINI_MODEL"] || "gemini-2.5-flash" };
}

export function hasGeminiCredentials(): boolean {
  return Boolean(process.env["GEMINI_API_KEY"]);
}

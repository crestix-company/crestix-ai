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

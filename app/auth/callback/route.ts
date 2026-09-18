import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  decryptRefreshToken,
  describeBase64Input,
  encryptRefreshToken,
} from "@/lib/security/token-encryption";
import { getTokenEncryptionKey } from "@/lib/security/server-secrets";
import { getAppOrigin } from "@/lib/auth/app-origin";

const callbackSchema = z.object({ code: z.string().min(1) });

export async function GET(request: NextRequest) {
  let appOrigin: string;
  try {
    appOrigin = getAppOrigin(request.headers);
  } catch {
    console.error("oauth_callback_origin_unavailable", { environment: process.env.NODE_ENV });
    return new Response("OAuth origin unavailable", { status: 500 });
  }
  const appUrl = (path: string) => new URL(path, appOrigin);
  console.info("oauth_callback_origin", {
    redirect_origin: appOrigin,
    forwarded_host_matches: request.headers.get("x-forwarded-host") === new URL(appOrigin).host,
    forwarded_proto_matches: request.headers.get("x-forwarded-proto") === new URL(appOrigin).protocol.slice(0, -1),
    host_matches: request.headers.get("host") === new URL(appOrigin).host,
  });
  const parsed = callbackSchema.safeParse({ code: request.nextUrl.searchParams.get("code") });
  if (!parsed.success) return NextResponse.redirect(appUrl("/login?error=invalid_callback"));

  const supabase = await createClient();
  const hasPkceVerifierCookie = request.cookies.getAll().some(({ name }) => name.includes("code-verifier"));
  let exchangeResult: Awaited<ReturnType<typeof supabase.auth.exchangeCodeForSession>>;
  try {
    exchangeResult = await supabase.auth.exchangeCodeForSession(parsed.data.code);
  } catch {
    console.error("oauth_callback_unexpected_failure", { stage: "exchange_code_for_session" });
    return new Response("OAuth exchange unavailable", { status: 503 });
  }
  const { data, error } = exchangeResult;
  if (error || !data.session) {
    const traceId = crypto.randomUUID();
    const errorCode = typeof error?.code === "string" && /^[a-z0-9_]{1,64}$/i.test(error.code)
      ? error.code
      : "session_exchange_failed";
    const safeMessage = error?.message.toLowerCase().includes("code verifier")
      ? "pkce_verifier_missing_or_invalid"
      : "oauth_session_exchange_failed";
    console.error("oauth_exchange_failed", {
      trace_id: traceId,
      error_code: errorCode,
      safe_message: safeMessage,
      request_origin: appOrigin,
      callback_pathname: request.nextUrl.pathname,
      environment: process.env.NODE_ENV,
      has_pkce_verifier_cookie: hasPkceVerifierCookie,
    });
    const loginUrl = appUrl("/login");
    loginUrl.searchParams.set("error", "oauth_exchange_failed");
    loginUrl.searchParams.set("trace", traceId);
    return NextResponse.redirect(loginUrl);
  }

  const user = data.session.user;
  const email = user.email;
  const refreshToken = data.session.provider_refresh_token;
  let encryptionKey: string;
  try {
    encryptionKey = await getTokenEncryptionKey();
  } catch {
    console.error("oauth_callback_unexpected_failure", { stage: "get_token_encryption_key" });
    await supabase.auth.signOut();
    return new Response("OAuth token storage unavailable", { status: 503 });
  }
  console.info("oauth_key_format", { key_format: describeBase64Input(encryptionKey) });
  const keyVersion = Number(process.env.TOKEN_KEY_VERSION ?? "1");
  const keyVersionValid = Number.isSafeInteger(keyVersion) && keyVersion > 0;
  const logCalendarFailure = (stage: string) => console.error("oauth_calendar_connection_failed", {
    stage,
    has_email: Boolean(email),
    has_provider_refresh_token: Boolean(refreshToken),
    key_version_valid: keyVersionValid,
  });
  if (!email || !keyVersionValid) {
    logCalendarFailure("invalid_prerequisites");
    await supabase.auth.signOut();
    return NextResponse.redirect(appUrl("/login?error=calendar_connection_failed"));
  }

  let encryptedRefreshToken: string;
  let storedKeyVersion = keyVersion;
  if (refreshToken) {
    try {
      encryptedRefreshToken = await encryptRefreshToken(refreshToken, encryptionKey, user.id);
    } catch {
      logCalendarFailure("encrypt_provider_refresh_token");
      await supabase.auth.signOut();
      return NextResponse.redirect(appUrl("/login?error=calendar_connection_failed"));
    }
  } else {
    let existing: { encrypted_refresh_token: string; token_key_version: number } | null;
    let lookupError: { code?: string } | null;
    try {
      const result = await supabase
        .from("google_connections")
        .select("encrypted_refresh_token, token_key_version")
        .eq("user_id", user.id)
        .maybeSingle();
      existing = result.data;
      lookupError = result.error;
    } catch {
      logCalendarFailure("google_connection_lookup_exception");
      await supabase.auth.signOut();
      return NextResponse.redirect(appUrl("/login?error=calendar_connection_failed"));
    }
    if (lookupError || !existing?.encrypted_refresh_token) {
      logCalendarFailure(lookupError ? "google_connection_lookup" : "google_connection_missing");
      await supabase.auth.signOut();
      return NextResponse.redirect(appUrl("/login?error=calendar_connection_failed"));
    }
    try {
      await decryptRefreshToken(existing.encrypted_refresh_token, encryptionKey, user.id);
    } catch {
      logCalendarFailure("stored_refresh_token_decrypt");
      await supabase.auth.signOut();
      return NextResponse.redirect(appUrl("/login?error=calendar_connection_failed"));
    }
    encryptedRefreshToken = existing.encrypted_refresh_token;
    storedKeyVersion = existing.token_key_version;
    console.info("oauth_refresh_token_reused", {
      reason: "provider_refresh_token_missing",
      stored_key_version: storedKeyVersion,
    });
  }
  const { error: profileError } = await supabase.from("profiles").upsert({
    id: user.id,
    email,
    display_name: typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : null,
  });
  if (profileError) {
    console.error("oauth_profile_upsert_failed", { db_error_code: profileError.code });
    return NextResponse.redirect(appUrl("/login?error=profile_failed"));
  }

  const { error: connectionError } = await supabase.from("google_connections").upsert({
    user_id: user.id,
    google_email: email,
    encrypted_refresh_token: encryptedRefreshToken,
    token_key_version: storedKeyVersion,
    is_active: true,
  }, { onConflict: "user_id" });
  if (connectionError) {
    console.error("oauth_calendar_connection_failed", {
      stage: "google_connection_upsert",
      db_error_code: connectionError.code,
    });
    return NextResponse.redirect(appUrl("/login?error=calendar_connection_failed"));
  }

  console.info("oauth_calendar_connection_ready", {
    used_new_provider_refresh_token: Boolean(refreshToken),
  });
  return NextResponse.redirect(appUrl("/fs/meetings"));
}

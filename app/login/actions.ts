"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getOAuthCallbackUrl } from "@/lib/auth/oauth-redirect";
import { getAppOrigin } from "@/lib/auth/app-origin";
import { createClient } from "@/lib/supabase/server";

export async function signInWithGoogle() {
  const requestHeaders = await headers();
  let callbackUrl: string;
  let appOrigin: string;
  try {
    appOrigin = getAppOrigin(requestHeaders);
    if (!requestHeaders.get("origin")) throw new Error("OAuth request origin is missing");
    callbackUrl = getOAuthCallbackUrl(appOrigin);
  } catch {
    // Fail closed rather than falling back to localhost or an untrusted host.
    throw new Error("OAuth application origin is unavailable");
  }
  console.info("oauth_redirect_to", { redirect_to: callbackUrl });
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackUrl,
      scopes: "openid email profile https://www.googleapis.com/auth/calendar.events.readonly",
      queryParams: {
        access_type: "offline",
        prompt: "consent",
      },
    },
  });
  if (error || !data.url) redirect(new URL("/login?error=oauth_start_failed", appOrigin).toString());
  redirect(data.url);
}

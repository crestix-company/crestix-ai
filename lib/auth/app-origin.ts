import "server-only";
import { resolveAppOrigin } from "@/lib/auth/oauth-redirect";

export function getAppOrigin(headers: Headers): string {
  return resolveAppOrigin({
    requestOrigin: headers.get("origin"),
    host: headers.get("host"),
    forwardedHost: headers.get("x-forwarded-host"),
    forwardedProto: headers.get("x-forwarded-proto"),
    isDevelopment: process.env.NODE_ENV === "development",
    vercelHost: process.env.VERCEL_URL,
    productionHost: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    isVercel: process.env.VERCEL === "1",
  });
}

/**
 * A request-derived appOrigin (getAppOrigin above) is NOT safe to reuse for
 * any URL this app registers with a third party or calls itself
 * server-to-server: confirmed live that a Vercel Cron invocation's request
 * resolves to the unique per-deployment URL, which - unlike the stable
 * production alias - is gated by Vercel's SSO/Deployment Protection
 * ("all_except_custom_domains" in this project's settings). A webhook
 * registration or self-fetch built from that origin gets silently
 * intercepted with a 401 before ever reaching this app's own route handler
 * (this is how Google's real Calendar webhook could start failing after a
 * cron-triggered watch renewal, and how this app's own internal
 * self-continuation fetch failed silently - fetch() doesn't throw on a
 * non-2xx response).
 *
 * VERCEL_PROJECT_PRODUCTION_URL is Vercel's own stable production hostname
 * regardless of which specific deployment is currently handling the
 * request - prefer it whenever this app is generating a URL for something
 * OTHER than the current request/response cycle itself (third-party
 * webhook registration, internal self-calls). appOrigin remains correct
 * for anything scoped to the current request (redirects, cookies) and is
 * the fallback here only for local dev, where this env var isn't set.
 */
export function resolveStableOrigin(appOrigin: string): string {
  const stableProductionHost = process.env["VERCEL_PROJECT_PRODUCTION_URL"];
  return stableProductionHost ? `https://${stableProductionHost}` : appOrigin;
}

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

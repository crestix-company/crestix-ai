import "server-only";

import { timingSafeEqual } from "node:crypto";
import { getCronSecret } from "@/lib/security/server-secrets";

/**
 * Shared by the cron route and the internal job-continuation route: both are
 * server-to-server triggers (Vercel cron, or this app calling itself to
 * resume a checkpointed job) gated by the same CRON_SECRET, never a
 * user-facing credential.
 */
export function isValidInternalBearerToken(header: string | null): boolean {
  let secret: string;
  try {
    secret = getCronSecret();
  } catch {
    return false;
  }

  const supplied = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

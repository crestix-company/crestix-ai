import "server-only";

import { timingSafeEqual } from "node:crypto";
import { getCronSecret, getSupabaseCronBridgeSecret } from "@/lib/security/server-secrets";

function isValidBearerToken(header: string | null, secret: string): boolean {
  const supplied = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
  return isValidBearerToken(header, secret);
}

/**
 * Gates /api/cron/jobs, called by Supabase's pg_cron + pg_net (not Vercel
 * Cron - see getSupabaseCronBridgeSecret's docstring) every few minutes to
 * sweep due MEETING_PREPARATION/MATERIAL_GENERATION jobs without needing a
 * human to manually nudge a stalled retry.
 */
export function isValidSupabaseCronBridgeToken(header: string | null): boolean {
  let secret: string;
  try {
    secret = getSupabaseCronBridgeSecret();
  } catch {
    return false;
  }
  return isValidBearerToken(header, secret);
}

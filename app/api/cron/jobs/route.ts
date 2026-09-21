import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/auth/app-origin";
import { runDuePreparationJobs } from "@/lib/jobs/calendar-jobs";
import { isValidSupabaseCronBridgeToken } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Lightweight, frequent job sweep - deliberately separate from
 * /api/cron/calendar-maintenance (the once-daily Vercel Cron, the maximum
 * frequency a Hobby plan allows). Delayed retries for MEETING_PREPARATION/
 * MATERIAL_GENERATION (e.g. Gemini 503 backoff) need to resume without a
 * human manually nudging a cron run once run_after arrives - see
 * getSupabaseCronBridgeSecret's docstring for how this gets called every
 * few minutes by Supabase's own pg_cron + pg_net, not Vercel Cron.
 * CALENDAR_SYNC/WATCH_RENEWAL are intentionally NOT swept here - those are
 * driven by webhooks + self-continuation, with the daily cron as their own
 * separate safety net.
 */
export async function GET(request: Request) {
  if (!isValidSupabaseCronBridgeToken(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const appOrigin = getAppOrigin(request.headers);
  const jobs = await runDuePreparationJobs(appOrigin, 10);

  return NextResponse.json({ ok: true, jobs });
}

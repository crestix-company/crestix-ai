import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/auth/app-origin";
import { SYNC_TIME_BUDGET_MS } from "@/lib/google/calendar-sync";
import { runJobToCompletionOrBudget } from "@/lib/jobs/calendar-jobs";
import { isValidInternalBearerToken } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Server-to-server only: resumes one checkpointed CALENDAR_SYNC job. Called
 * by triggerCalendarSyncContinuation (lib/jobs/calendar-jobs.ts) so a large
 * initial backfill keeps draining across chained invocations without a
 * human re-editing the Calendar event or waiting for the next cron tick.
 * Never reachable from the browser or with a user credential.
 */
export async function POST(request: Request) {
  if (!isValidInternalBearerToken(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let jobId: string | null = null;
  try {
    const body = (await request.json()) as { jobId?: unknown };
    jobId = typeof body.jobId === "string" && body.jobId ? body.jobId : null;
  } catch {
    jobId = null;
  }
  if (!jobId) return NextResponse.json({ ok: false, error: "missing_job_id" }, { status: 400 });

  const appOrigin = getAppOrigin(request.headers);
  const deadline = Date.now() + SYNC_TIME_BUDGET_MS;
  const result = await runJobToCompletionOrBudget(jobId, appOrigin, deadline);

  return NextResponse.json({ ok: true, jobId, result });
}

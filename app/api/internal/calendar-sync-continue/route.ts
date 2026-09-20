import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/auth/app-origin";
import { SYNC_TIME_BUDGET_MS } from "@/lib/google/calendar-sync";
import { runDuePreparationJobs, runJobToCompletionOrBudget } from "@/lib/jobs/calendar-jobs";
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
  console.info("calendar_sync_continue_job_processed", { job_id: jobId, result });

  if (result === "done") {
    try {
      // Mirrors the webhook route: a CALENDAR_SYNC job that finishes via a
      // self-continuation chain (rather than the original webhook request)
      // still needs its freshly-enqueued MEETING_PREPARATION job swept -
      // without this, that job sits PENDING until the next cron tick.
      let sweep = await runDuePreparationJobs(appOrigin);
      let rounds = 0;
      while (sweep.attempted > 0 && (sweep.done > 0 || sweep.retry > 0) && rounds < 5) {
        sweep = await runDuePreparationJobs(appOrigin);
        rounds += 1;
      }
      console.info("calendar_sync_continue_preparation_jobs_processed", sweep);
    } catch (preparationError) {
      console.error("calendar_sync_continue_preparation_jobs_failed", {
        code: preparationError instanceof Error ? preparationError.message : "unknown",
      });
    }
  }

  return NextResponse.json({ ok: true, jobId, result });
}

import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/auth/app-origin";
import { renewExpiringCalendarWatches } from "@/lib/google/calendar-sync";
import { runDueCalendarJobs } from "@/lib/jobs/calendar-jobs";
import { isValidInternalBearerToken } from "@/lib/security/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isValidInternalBearerToken(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const appOrigin = getAppOrigin(request.headers);
  const renewal = await renewExpiringCalendarWatches(appOrigin);
  const jobs = await runDueCalendarJobs(appOrigin, 10);

  return NextResponse.json({ ok: true, renewal, jobs });
}

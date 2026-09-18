import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/auth/app-origin";
import { renewExpiringCalendarWatches } from "@/lib/google/calendar-sync";
import { runDueCalendarJobs } from "@/lib/jobs/calendar-jobs";
import { getCronSecret } from "@/lib/security/server-secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function validBearerToken(header: string | null, secret: string): boolean {
  const supplied = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  let secret: string;
  try {
    secret = getCronSecret();
  } catch {
    return NextResponse.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  }

  if (!validBearerToken(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const appOrigin = getAppOrigin(request.headers);
  const renewal = await renewExpiringCalendarWatches(appOrigin);
  const jobs = await runDueCalendarJobs(appOrigin, 10);

  return NextResponse.json({ ok: true, renewal, jobs });
}

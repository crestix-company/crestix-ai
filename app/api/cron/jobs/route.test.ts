import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDuePreparationJobs } from "@/lib/jobs/calendar-jobs";
import { isValidSupabaseCronBridgeToken } from "@/lib/security/internal-auth";
import { GET } from "./route";

vi.mock("@/lib/jobs/calendar-jobs", () => ({
  runDuePreparationJobs: vi.fn(),
}));
vi.mock("@/lib/security/internal-auth", () => ({
  isValidSupabaseCronBridgeToken: vi.fn(),
}));

function makeRequest(): Request {
  return new Request("https://crestix-ai.vercel.app/api/cron/jobs", {
    method: "GET",
    headers: { authorization: "Bearer test", host: "crestix-ai.vercel.app" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isValidSupabaseCronBridgeToken).mockReturnValue(true);
});

describe("GET /api/cron/jobs", () => {
  it("rejects a request without a valid Supabase cron bridge token - distinct from the Vercel CRON_SECRET check", async () => {
    vi.mocked(isValidSupabaseCronBridgeToken).mockReturnValue(false);
    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
    expect(runDuePreparationJobs).not.toHaveBeenCalled();
  });

  it("sweeps due MEETING_PREPARATION/MATERIAL_GENERATION jobs and never touches CALENDAR_SYNC/WATCH_RENEWAL", async () => {
    vi.mocked(runDuePreparationJobs).mockResolvedValue({ attempted: 2, done: 1, retry: 1, failed: 0, continuing: 0 });

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(runDuePreparationJobs).toHaveBeenCalledTimes(1);
    expect(runDuePreparationJobs).toHaveBeenCalledWith(expect.any(String), 10);
  });
});

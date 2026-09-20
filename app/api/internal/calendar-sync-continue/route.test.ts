import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDuePreparationJobs, runJobToCompletionOrBudget } from "@/lib/jobs/calendar-jobs";
import { isValidInternalBearerToken } from "@/lib/security/internal-auth";
import { POST } from "./route";

vi.mock("@/lib/jobs/calendar-jobs", () => ({
  runJobToCompletionOrBudget: vi.fn(),
  runDuePreparationJobs: vi.fn(),
}));
vi.mock("@/lib/security/internal-auth", () => ({
  isValidInternalBearerToken: vi.fn(),
}));
vi.mock("@/lib/google/calendar-sync", () => ({ SYNC_TIME_BUDGET_MS: 45_000 }));

function makeRequest(jobId: unknown): Request {
  return new Request("https://crestix-ai.vercel.app/api/internal/calendar-sync-continue", {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json", host: "crestix-ai.vercel.app" },
    body: JSON.stringify({ jobId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isValidInternalBearerToken).mockReturnValue(true);
});

describe("POST /api/internal/calendar-sync-continue", () => {
  it("rejects a request without a valid bearer token", async () => {
    vi.mocked(isValidInternalBearerToken).mockReturnValue(false);
    const response = await POST(makeRequest("job-1"));
    expect(response.status).toBe(401);
    expect(runJobToCompletionOrBudget).not.toHaveBeenCalled();
  });

  it("rejects a request with no jobId", async () => {
    const response = await POST(makeRequest(undefined));
    expect(response.status).toBe(400);
  });

  it("processes the job and, on done, sweeps due MEETING_PREPARATION/MATERIAL_GENERATION jobs (mirrors the webhook route - a CALENDAR_SYNC finishing via self-continuation instead of the original webhook still needs this)", async () => {
    vi.mocked(runJobToCompletionOrBudget).mockResolvedValue("done");
    vi.mocked(runDuePreparationJobs)
      .mockResolvedValueOnce({ attempted: 1, done: 1, retry: 0, failed: 0, continuing: 0 })
      .mockResolvedValueOnce({ attempted: 0, done: 0, retry: 0, failed: 0, continuing: 0 });

    const response = await POST(makeRequest("job-1"));

    expect(response.status).toBe(200);
    expect(runJobToCompletionOrBudget).toHaveBeenCalledWith("job-1", expect.any(String), expect.any(Number));
    expect(runDuePreparationJobs).toHaveBeenCalledTimes(2);
  });

  it("does not sweep preparation jobs when the CALENDAR_SYNC job is still continuing (not done)", async () => {
    vi.mocked(runJobToCompletionOrBudget).mockResolvedValue("continuing");

    await POST(makeRequest("job-1"));

    expect(runDuePreparationJobs).not.toHaveBeenCalled();
  });
});

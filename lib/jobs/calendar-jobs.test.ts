import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureCalendarWatch, syncGoogleCalendarConnection } from "@/lib/google/calendar-sync";
import { runAutoPreparationForMeeting } from "@/lib/preparation/auto-generate";
import { runMaterialGenerationForMeeting } from "@/lib/preparation/material-generate";
import { processCalendarJob, runDueCalendarJobs, runJobToCompletionOrBudget } from "./calendar-jobs";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/google/calendar-sync", () => ({
  syncGoogleCalendarConnection: vi.fn().mockResolvedValue({ eventCount: 0, syncTokenStored: false, completed: true }),
  ensureCalendarWatch: vi.fn().mockResolvedValue({ watchId: "watch-1", renewed: false }),
  safeCalendarErrorCode: (error: unknown) => (error instanceof Error ? error.message : "unknown"),
  SYNC_TIME_BUDGET_MS: 45_000,
}));
vi.mock("@/lib/preparation/auto-generate", () => ({
  runAutoPreparationForMeeting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/preparation/material-generate", () => ({
  runMaterialGenerationForMeeting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/security/server-secrets", () => ({
  getCronSecret: () => "test-cron-secret",
}));
// Vitest has no real Next.js request-execution context, so the genuine
// after() throws synchronously ("called outside a request scope"). Mocked
// to run its callback inline so tests can assert what gets scheduled
// (URL/headers/body) - the real after()'s own delivery semantics are a
// Next.js/Vercel runtime concern, not something a unit test should model.
vi.mock("next/server", () => ({
  after: (callback: () => void | Promise<void>) => { void callback(); },
}));

type Canned = { data?: unknown; error?: unknown };

interface FakeChain extends PromiseLike<Canned> {
  select(...args: unknown[]): FakeChain;
  update(...args: unknown[]): FakeChain;
  eq(...args: unknown[]): FakeChain;
  neq(...args: unknown[]): FakeChain;
  lt(...args: unknown[]): FakeChain;
  lte(...args: unknown[]): FakeChain;
  in(...args: unknown[]): FakeChain;
  order(...args: unknown[]): FakeChain;
  limit(...args: unknown[]): FakeChain;
  maybeSingle(): Promise<Canned>;
}

function makeAdminMock(queues: Record<string, Canned[]>) {
  const calls: Record<string, unknown[]> = {};
  function from(table: string): FakeChain {
    let rootMethod: string | null = null;
    const resolve = (): Promise<Canned> => {
      const key = `${table}:${rootMethod}`;
      const queue = queues[key];
      const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      return Promise.resolve(next ?? { data: null, error: null });
    };
    const chain: FakeChain = {
      select: () => { rootMethod ??= "select"; return chain; },
      update: (payload: unknown) => {
        rootMethod ??= "update";
        (calls[table] ??= []).push(payload);
        return chain;
      },
      eq: () => chain,
      neq: () => chain,
      lt: () => chain,
      lte: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => resolve(),
      then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
    };
    return chain;
  }
  return { client: { from }, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processCalendarJob - stale RUNNING reclaim on a direct call", () => {
  it("reclaims stale RUNNING jobs even when called directly for a single job (not via the sweep)", async () => {
    // This is exactly the production scenario that went wrong: the webhook
    // calls processCalendarJob directly for the one job it just enqueued,
    // which never goes through runDueJobsOfTypes's sweep at all. Without a
    // reclaim here too, an earlier job stuck RUNNING from a prior timed-out
    // invocation was never reclaimed by anything until the daily cron.
    const { client, calls } = makeAdminMock({
      "jobs:select": [{ data: { id: "job-1", job_type: "MEETING_PREPARATION", google_connection_id: null, meeting_id: "meeting-1", status: "PENDING", attempts: 0, run_after: new Date(0).toISOString() } }],
      "jobs:update": [
        { data: null, error: null }, // reclaim
        { data: { id: "job-1" }, error: null }, // claim
        { data: null, error: null }, // DONE
      ],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await processCalendarJob("job-1", "https://example.test");

    expect(result).toBe("done");
    expect(calls.jobs[0]).toMatchObject({
      status: "PENDING",
      locked_at: null,
      last_error_safe: "stale_running_reclaimed",
    });
  });
});

describe("processCalendarJob - MEETING_PREPARATION", () => {
  it("calls runAutoPreparationForMeeting with the job's meeting_id and marks the job DONE, without touching Calendar sync", async () => {
    const { client } = makeAdminMock({
      "jobs:select": [{ data: { id: "job-1", job_type: "MEETING_PREPARATION", google_connection_id: null, meeting_id: "meeting-1", status: "PENDING", attempts: 0, run_after: new Date(0).toISOString() } }],
      "jobs:update": [{ data: { id: "job-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await processCalendarJob("job-1", "https://example.test");

    expect(result).toBe("done");
    expect(runAutoPreparationForMeeting).toHaveBeenCalledWith("meeting-1");
    expect(syncGoogleCalendarConnection).not.toHaveBeenCalled();
    expect(ensureCalendarWatch).not.toHaveBeenCalled();
  });

  it("a Gemini/preparation failure retries the job with backoff instead of failing Calendar sync", async () => {
    vi.mocked(runAutoPreparationForMeeting).mockRejectedValueOnce(new Error("gemini_timeout"));
    const { client, calls } = makeAdminMock({
      "jobs:select": [{ data: { id: "job-1", job_type: "MEETING_PREPARATION", google_connection_id: null, meeting_id: "meeting-1", status: "PENDING", attempts: 1, run_after: new Date(0).toISOString() } }],
      "jobs:update": [{ data: { id: "job-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await processCalendarJob("job-1", "https://example.test");

    expect(result).toBe("retry");
    const finalUpdate = calls.jobs[calls.jobs.length - 1] as Record<string, unknown>;
    expect(finalUpdate.status).toBe("PENDING");
    expect(finalUpdate.last_error_safe).toBe("gemini_timeout");
    expect(syncGoogleCalendarConnection).not.toHaveBeenCalled();
  });

  it("flips meeting_preparations and meetings to FAILED only once max attempts are exhausted", async () => {
    vi.mocked(runAutoPreparationForMeeting).mockRejectedValueOnce(new Error("gemini_timeout"));
    const { client, calls } = makeAdminMock({
      // attempts=4 -> nextAttempts=5 = MAX_ATTEMPTS
      "jobs:select": [{ data: { id: "job-1", job_type: "MEETING_PREPARATION", google_connection_id: null, meeting_id: "meeting-1", status: "PENDING", attempts: 4, run_after: new Date(0).toISOString() } }],
      "jobs:update": [{ data: { id: "job-1" }, error: null }],
      "meeting_preparations:update": [{ data: null, error: null }],
      "meetings:update": [{ data: null, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await processCalendarJob("job-1", "https://example.test");

    expect(result).toBe("failed");
    expect(calls.meeting_preparations).toEqual([{ status: "FAILED" }]);
    expect(calls.meetings).toEqual([{ status: "FAILED" }]);
  });
});

describe("processCalendarJob - CALENDAR_SYNC", () => {
  it("never calls runAutoPreparationForMeeting", async () => {
    const { client } = makeAdminMock({
      "jobs:select": [{ data: { id: "job-2", job_type: "CALENDAR_SYNC", google_connection_id: "conn-1", meeting_id: null, status: "PENDING", attempts: 0, run_after: new Date(0).toISOString() } }],
      "jobs:update": [{ data: { id: "job-2" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await processCalendarJob("job-2", "https://example.test");

    expect(result).toBe("done");
    expect(syncGoogleCalendarConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ deadline: expect.any(Number) }),
    );
    expect(runAutoPreparationForMeeting).not.toHaveBeenCalled();
  });

  it("checkpoints gracefully without consuming an attempt when the sync reports it did not complete", async () => {
    // This is the point-C guarantee: normal pagination continuation (time
    // budget hit mid-backfill, pending_page_token already persisted by
    // syncGoogleCalendarConnection itself) must NOT count against
    // MAX_ATTEMPTS the way a genuine Google API error does.
    vi.mocked(syncGoogleCalendarConnection).mockResolvedValueOnce({
      eventCount: 100,
      syncTokenStored: false,
      completed: false,
    });
    const { client, calls } = makeAdminMock({
      "jobs:select": [{ data: { id: "job-2", job_type: "CALENDAR_SYNC", google_connection_id: "conn-1", meeting_id: null, status: "PENDING", attempts: 2, run_after: new Date(0).toISOString() } }],
      "jobs:update": [{ data: { id: "job-2" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await processCalendarJob("job-2", "https://example.test");

    expect(result).toBe("continuing");
    const checkpointUpdate = calls.jobs[calls.jobs.length - 1] as Record<string, unknown>;
    expect(checkpointUpdate).toMatchObject({
      status: "PENDING",
      // Reverted back to the pre-claim value (2), not the claimed nextAttempts (3).
      attempts: 2,
      locked_at: null,
    });
  });
});

describe("runJobToCompletionOrBudget", () => {
  it("keeps re-invoking the same job while it reports continuing, until it finishes within the shared deadline", async () => {
    vi.mocked(syncGoogleCalendarConnection)
      .mockResolvedValueOnce({ eventCount: 100, syncTokenStored: false, completed: false })
      .mockResolvedValueOnce({ eventCount: 40, syncTokenStored: true, completed: true });

    const { client } = makeAdminMock({
      "jobs:select": [
        { data: { id: "job-2", job_type: "CALENDAR_SYNC", google_connection_id: "conn-1", meeting_id: null, status: "PENDING", attempts: 0, run_after: new Date(0).toISOString() } },
      ],
      "jobs:update": [{ data: { id: "job-2" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await runJobToCompletionOrBudget("job-2", "https://example.test", Date.now() + 45_000);

    expect(result).toBe("done");
    expect(syncGoogleCalendarConnection).toHaveBeenCalledTimes(2);
  });
});

describe("runDueCalendarJobs - stale RUNNING recovery", () => {
  it("resets jobs stuck RUNNING past the staleness threshold to PENDING before picking up due work", async () => {
    const { client, calls } = makeAdminMock({
      "jobs:select": [
        { data: [{ id: "job-3" }], error: null },
        { data: { id: "job-3", job_type: "CALENDAR_SYNC", google_connection_id: "conn-1", meeting_id: null, status: "PENDING", attempts: 1, run_after: new Date(0).toISOString() } },
      ],
      "jobs:update": [
        { data: null, error: null }, // reclaim inside runDueJobsOfTypes
        { data: null, error: null }, // reclaim inside processCalendarJob
        { data: { id: "job-3" }, error: null }, // claim
        { data: null, error: null }, // DONE
      ],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await runDueCalendarJobs("https://example.test", 10);

    const firstUpdate = calls.jobs[0] as Record<string, unknown>;
    expect(firstUpdate).toMatchObject({
      status: "PENDING",
      locked_at: null,
      last_error_safe: "stale_running_reclaimed",
    });
    expect(syncGoogleCalendarConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ deadline: expect.any(Number) }),
    );
  });
});

describe("processCalendarJob - MATERIAL_GENERATION", () => {
  it("calls runMaterialGenerationForMeeting with the job's meeting_id and marks the job DONE", async () => {
    const { client } = makeAdminMock({
      "jobs:select": [{ data: { id: "job-4", job_type: "MATERIAL_GENERATION", google_connection_id: null, meeting_id: "meeting-1", status: "PENDING", attempts: 0, run_after: new Date(0).toISOString() } }],
      "jobs:update": [{ data: { id: "job-4" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await processCalendarJob("job-4", "https://example.test");

    expect(result).toBe("done");
    expect(runMaterialGenerationForMeeting).toHaveBeenCalledWith("meeting-1");
  });

  it("on final failure, marks only meeting_materials FAILED - never meeting_preparations or meetings", async () => {
    vi.mocked(runMaterialGenerationForMeeting).mockRejectedValueOnce(new Error("gemini_material_response_invalid_schema"));
    const { client, calls } = makeAdminMock({
      // attempts=4 -> nextAttempts=5 = MAX_ATTEMPTS
      "jobs:select": [{ data: { id: "job-4", job_type: "MATERIAL_GENERATION", google_connection_id: null, meeting_id: "meeting-1", status: "PENDING", attempts: 4, run_after: new Date(0).toISOString() } }],
      "jobs:update": [{ data: { id: "job-4" }, error: null }],
      "meeting_materials:update": [{ data: null, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await processCalendarJob("job-4", "https://example.test");

    expect(result).toBe("failed");
    expect(calls.meeting_materials).toEqual([{
      status: "FAILED",
      error_safe: "gemini_material_response_invalid_schema",
    }]);
    expect(calls.meetings).toBeUndefined();
    expect(calls.meeting_preparations).toBeUndefined();
  });

  it("retries with backoff before max attempts, without touching meeting_materials", async () => {
    vi.mocked(runMaterialGenerationForMeeting).mockRejectedValueOnce(new Error("gemini_timeout"));
    const { client, calls } = makeAdminMock({
      "jobs:select": [{ data: { id: "job-4", job_type: "MATERIAL_GENERATION", google_connection_id: null, meeting_id: "meeting-1", status: "PENDING", attempts: 1, run_after: new Date(0).toISOString() } }],
      "jobs:update": [{ data: { id: "job-4" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await processCalendarJob("job-4", "https://example.test");

    expect(result).toBe("retry");
    expect(calls.meeting_materials).toBeUndefined();
  });
});

describe("runJobToCompletionOrBudget - self-continuation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires a background self-request to the internal continuation route when the job still isn't done at the deadline", async () => {
    vi.mocked(syncGoogleCalendarConnection).mockResolvedValue({ eventCount: 10, syncTokenStored: false, completed: false });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { client } = makeAdminMock({
      "jobs:select": [{ data: { id: "job-5", job_type: "CALENDAR_SYNC", google_connection_id: "conn-1", meeting_id: null, status: "PENDING", attempts: 0, run_after: new Date(0).toISOString() } }],
      "jobs:update": [{ data: { id: "job-5" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const pastDeadline = Date.now() - 1;
    const result = await runJobToCompletionOrBudget("job-5", "https://example.test", pastDeadline);

    expect(result).toBe("continuing");
    // after() runs its callback once the current tick finishes - flush it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/api/internal/calendar-sync-continue",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-cron-secret" }),
        body: JSON.stringify({ jobId: "job-5" }),
      }),
    );
  });

  it("does not self-trigger once the job actually completes within the budget", async () => {
    vi.mocked(syncGoogleCalendarConnection).mockResolvedValue({ eventCount: 5, syncTokenStored: true, completed: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { client } = makeAdminMock({
      "jobs:select": [{ data: { id: "job-6", job_type: "CALENDAR_SYNC", google_connection_id: "conn-1", meeting_id: null, status: "PENDING", attempts: 0, run_after: new Date(0).toISOString() } }],
      "jobs:update": [{ data: { id: "job-6" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await runJobToCompletionOrBudget("job-6", "https://example.test", Date.now() + 45_000);

    expect(result).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("processCalendarJob - CALENDAR_SYNC continuation safety cap", () => {
  it("fails a job that has checkpointed past MAX_SYNC_CONTINUATIONS instead of self-triggering forever", async () => {
    vi.mocked(syncGoogleCalendarConnection).mockResolvedValueOnce({ eventCount: 1, syncTokenStored: false, completed: false });
    const { client, calls } = makeAdminMock({
      "jobs:select": [{
        data: {
          id: "job-7", job_type: "CALENDAR_SYNC", google_connection_id: "conn-1", meeting_id: null,
          status: "PENDING", attempts: 3, run_after: new Date(0).toISOString(),
          payload: { continuation_count: 200 },
        },
      }],
      "jobs:update": [{ data: { id: "job-7" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await processCalendarJob("job-7", "https://example.test");

    expect(result).toBe("failed");
    const finalUpdate = calls.jobs[calls.jobs.length - 1] as Record<string, unknown>;
    expect(finalUpdate).toMatchObject({
      status: "FAILED",
      last_error_safe: "calendar_sync_continuation_limit_exceeded",
    });
  });
});

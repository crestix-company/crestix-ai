import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureCalendarWatch, syncGoogleCalendarConnection } from "@/lib/google/calendar-sync";
import { runAutoPreparationForMeeting } from "@/lib/preparation/auto-generate";
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

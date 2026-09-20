import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  enqueueCalendarSyncJob,
  runDuePreparationJobs,
  runJobToCompletionOrBudget,
} from "@/lib/jobs/calendar-jobs";
import { POST } from "./route";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/jobs/calendar-jobs", () => ({
  enqueueCalendarSyncJob: vi.fn(),
  runDuePreparationJobs: vi.fn().mockResolvedValue({ attempted: 0, done: 0, retry: 0, failed: 0, continuing: 0 }),
  runJobToCompletionOrBudget: vi.fn().mockResolvedValue("done"),
}));
vi.mock("@/lib/google/calendar-sync", () => ({ SYNC_TIME_BUDGET_MS: 45_000 }));
// after() needs a real Next.js request context, unavailable in Vitest -
// mocked to run its callback inline, same pattern as calendar-jobs.test.ts.
vi.mock("next/server", () => ({
  after: (callback: () => void | Promise<void>) => { void callback(); },
}));

type Canned = { data?: unknown; error?: unknown };

interface FakeChain extends PromiseLike<Canned> {
  select(...args: unknown[]): FakeChain;
  update(...args: unknown[]): FakeChain;
  eq(...args: unknown[]): FakeChain;
  in(...args: unknown[]): FakeChain;
  order(...args: unknown[]): FakeChain;
  limit(...args: unknown[]): FakeChain;
  maybeSingle(): Promise<Canned>;
}

function makeAdminMock(queues: Record<string, Canned[]>) {
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
      update: () => { rootMethod ??= "update"; return chain; },
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => resolve(),
      then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
    };
    return chain;
  }
  return { from };
}

function makeRequest(messageNumber: string): Request {
  return new Request("https://crestix-ai.vercel.app/api/webhooks/google-calendar", {
    method: "POST",
    headers: {
      "x-goog-channel-id": "channel-1",
      "x-goog-channel-token": "raw-token",
      "x-goog-resource-id": "resource-1",
      "x-goog-resource-state": "exists",
      "x-goog-message-number": messageNumber,
      host: "crestix-ai.vercel.app",
    },
  });
}

const channelRow = {
  id: "watch-1",
  google_connection_id: "conn-1",
  resource_id: "resource-1",
  last_message_number: 10,
  status: "ACTIVE",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runDuePreparationJobs).mockResolvedValue({ attempted: 0, done: 0, retry: 0, failed: 0, continuing: 0 });
});

describe("POST /api/webhooks/google-calendar", () => {
  it("processes the newly-enqueued job when enqueueCalendarSyncJob returns a fresh id", async () => {
    vi.mocked(enqueueCalendarSyncJob).mockResolvedValue("job-new");
    const client = makeAdminMock({
      "calendar_watch_channels:select": [{ data: channelRow, error: null }],
      "calendar_watch_channels:update": [{ data: null, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const response = await POST(makeRequest("11"));

    expect(response.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runJobToCompletionOrBudget).toHaveBeenCalledWith("job-new", expect.any(String), expect.any(Number));
  });

  it("falls back to the existing active job instead of doing nothing when the webhook's own job gets coalesced away", async () => {
    // enqueueCalendarSyncJob returning null means a unique-constraint
    // conflict on the per-connection coalescing index - an active
    // CALENDAR_SYNC job already exists. This webhook delivery must still
    // give that existing job a chance to progress, not silently no-op.
    vi.mocked(enqueueCalendarSyncJob).mockResolvedValue(null);
    const client = makeAdminMock({
      "calendar_watch_channels:select": [{ data: channelRow, error: null }],
      "calendar_watch_channels:update": [{ data: null, error: null }],
      "jobs:select": [{ data: { id: "job-existing-active" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const response = await POST(makeRequest("12"));

    expect(response.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runJobToCompletionOrBudget).toHaveBeenCalledWith("job-existing-active", expect.any(String), expect.any(Number));
  });

  it("does nothing when coalesced AND no active job is found either (e.g. it just finished between the enqueue attempt and this lookup)", async () => {
    vi.mocked(enqueueCalendarSyncJob).mockResolvedValue(null);
    const client = makeAdminMock({
      "calendar_watch_channels:select": [{ data: channelRow, error: null }],
      "calendar_watch_channels:update": [{ data: null, error: null }],
      "jobs:select": [{ data: null, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const response = await POST(makeRequest("13"));

    expect(response.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runJobToCompletionOrBudget).not.toHaveBeenCalled();
  });

  it("ignores a duplicate/replayed notification (messageNumber <= last_message_number)", async () => {
    const client = makeAdminMock({
      "calendar_watch_channels:select": [{ data: channelRow, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const response = await POST(makeRequest("10"));

    expect(response.status).toBe(204);
    expect(enqueueCalendarSyncJob).not.toHaveBeenCalled();
  });
});

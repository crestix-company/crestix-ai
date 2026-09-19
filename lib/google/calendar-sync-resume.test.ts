import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { listCalendarEventsPage } from "@/lib/google/calendar-api";
import { syncGoogleCalendarConnection } from "./calendar-sync";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/google/calendar-api", () => ({
  GoogleCalendarApiError: class GoogleCalendarApiError extends Error {},
  listCalendarEventsPage: vi.fn(),
  refreshGoogleAccessToken: vi.fn(),
  stopCalendarWatch: vi.fn(),
  watchCalendarEvents: vi.fn(),
}));

const connectionRow = {
  id: "conn-1",
  user_id: "user-1",
  calendar_id: "primary",
  encrypted_refresh_token: "ciphertext",
  token_key_version: 1,
  is_active: true,
};
const membershipRow = { organization_id: "org-1" };
const nonMatchingEvent = { id: "gevent-1", summary: "定例MTG", status: "confirmed" as const };

type Canned = { data?: unknown; error?: unknown };

interface FakeChain extends PromiseLike<Canned> {
  select(...args: unknown[]): FakeChain;
  upsert(...args: unknown[]): FakeChain;
  update(...args: unknown[]): FakeChain;
  eq(...args: unknown[]): FakeChain;
  order(...args: unknown[]): FakeChain;
  limit(...args: unknown[]): FakeChain;
  maybeSingle(): Promise<Canned>;
  single(): Promise<Canned>;
}

function makeAdminMock(queues: Record<string, Canned[]>) {
  const watchUpdateCalls: Array<Record<string, unknown>> = [];
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
      upsert: () => { rootMethod ??= "upsert"; return chain; },
      update: (payload: unknown) => {
        rootMethod ??= "update";
        if (table === "calendar_watch_channels") watchUpdateCalls.push(payload as Record<string, unknown>);
        return chain;
      },
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => resolve(),
      single: () => resolve(),
      then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
    };
    return chain;
  }
  return { client: { from }, watchUpdateCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncGoogleCalendarConnection - page resume", () => {
  it("persists pending_page_token after each page so a killed run can resume, and clears it on completion", async () => {
    vi.mocked(listCalendarEventsPage)
      .mockResolvedValueOnce({ items: [nonMatchingEvent], nextPageToken: "page-2-token" })
      .mockResolvedValueOnce({ items: [nonMatchingEvent], nextSyncToken: "final-sync-token" });

    const { client, watchUpdateCalls } = makeAdminMock({
      "google_connections:select": [{ data: connectionRow, error: null }],
      "organization_memberships:select": [{ data: membershipRow, error: null }],
      "calendar_watch_channels:select": [{
        data: {
          id: "watch-1", channel_id: "c1", resource_id: "r1",
          sync_token: null, pending_page_token: null,
          expiration_at: new Date(Date.now() + 999999).toISOString(), status: "ACTIVE",
        },
        error: null,
      }],
      "calendar_events:select": [{ data: null, error: null }],
      "calendar_events:upsert": [{ data: { id: "event-row-1" }, error: null }],
      "meetings:select": [{ data: null, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await syncGoogleCalendarConnection("conn-1", { accessToken: "token-x" });

    expect(result).toEqual({ eventCount: 2, syncTokenStored: true });
    expect(listCalendarEventsPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listCalendarEventsPage).mock.calls[0][0]).toMatchObject({ pageToken: null });
    expect(vi.mocked(listCalendarEventsPage).mock.calls[1][0]).toMatchObject({ pageToken: "page-2-token" });

    // First watch update after page 1 persists the resume token.
    expect(watchUpdateCalls[0]).toMatchObject({ pending_page_token: "page-2-token" });
    // Final state: sync_token stored, pending_page_token cleared.
    const finalUpdate = watchUpdateCalls[watchUpdateCalls.length - 1];
    expect(finalUpdate).toMatchObject({ sync_token: "final-sync-token", pending_page_token: null });
  });

  it("resumes from a previously persisted pending_page_token instead of restarting the initial backfill", async () => {
    vi.mocked(listCalendarEventsPage).mockResolvedValueOnce({
      items: [nonMatchingEvent],
      nextSyncToken: "final-sync-token",
    });

    const { client } = makeAdminMock({
      "google_connections:select": [{ data: connectionRow, error: null }],
      "organization_memberships:select": [{ data: membershipRow, error: null }],
      "calendar_watch_channels:select": [{
        data: {
          id: "watch-1", channel_id: "c1", resource_id: "r1",
          sync_token: null, pending_page_token: "resume-token",
          expiration_at: new Date(Date.now() + 999999).toISOString(), status: "ACTIVE",
        },
        error: null,
      }],
      "calendar_events:select": [{ data: null, error: null }],
      "calendar_events:upsert": [{ data: { id: "event-row-1" }, error: null }],
      "meetings:select": [{ data: null, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await syncGoogleCalendarConnection("conn-1", { accessToken: "token-x" });

    expect(listCalendarEventsPage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listCalendarEventsPage).mock.calls[0][0]).toMatchObject({
      pageToken: "resume-token",
      initialTimeMin: null,
    });
  });
});

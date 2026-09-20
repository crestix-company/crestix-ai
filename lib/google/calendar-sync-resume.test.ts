import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { GoogleCalendarApiError, listCalendarEventsPage } from "@/lib/google/calendar-api";
import { syncGoogleCalendarConnection } from "./calendar-sync";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/google/calendar-api", () => ({
  GoogleCalendarApiError: class GoogleCalendarApiError extends Error {
    constructor(readonly operation: string, readonly status: number) {
      super(`mock_google_calendar_api_error:${operation}:${status}`);
    }
  },
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

    expect(result).toEqual({ eventCount: 2, syncTokenStored: true, completed: true });
    expect(listCalendarEventsPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listCalendarEventsPage).mock.calls[0][0]).toMatchObject({ pageToken: null });
    expect(vi.mocked(listCalendarEventsPage).mock.calls[1][0]).toMatchObject({ pageToken: "page-2-token" });

    // A fresh sync (no syncToken, no resume pageToken) backfills 1 day back
    // and bounds the future side too, so an unbounded recurring series can't
    // make "1 day back" balloon into an effectively unbounded query.
    const initialTimeMin = new Date(
      (vi.mocked(listCalendarEventsPage).mock.calls[0][0] as { initialTimeMin: string }).initialTimeMin,
    );
    const expectedOneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    expect(Math.abs(initialTimeMin.getTime() - expectedOneDayAgo)).toBeLessThan(5_000);

    const initialTimeMax = new Date(
      (vi.mocked(listCalendarEventsPage).mock.calls[0][0] as { initialTimeMax: string }).initialTimeMax,
    );
    const expectedOneYearAhead = Date.now() + 365 * 24 * 60 * 60 * 1000;
    expect(Math.abs(initialTimeMax.getTime() - expectedOneYearAhead)).toBeLessThan(5_000);

    // Paginating the SAME initial query (via pageToken, not syncToken) must
    // keep repeating the original timeMin/timeMax on every page - only a
    // syncToken-only request omits them.
    expect(
      (vi.mocked(listCalendarEventsPage).mock.calls[1][0] as { initialTimeMin: string }).initialTimeMin,
    ).toBe((vi.mocked(listCalendarEventsPage).mock.calls[0][0] as { initialTimeMin: string }).initialTimeMin);

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

describe("syncGoogleCalendarConnection - 410 Gone recovery", () => {
  it("discards the stale sync_token/pending_page_token and falls back to a fresh bounded initial sync (not another syncToken attempt)", async () => {
    vi.mocked(listCalendarEventsPage)
      .mockRejectedValueOnce(new GoogleCalendarApiError("events_list", 410))
      .mockResolvedValueOnce({ items: [nonMatchingEvent], nextSyncToken: "fresh-sync-token" });

    const { client, watchUpdateCalls } = makeAdminMock({
      "google_connections:select": [{ data: connectionRow, error: null }],
      "organization_memberships:select": [{ data: membershipRow, error: null }],
      // Two entries: the initial lookup (before recovery) sees the stale
      // sync_token; the recursive retry's re-fetch (by watchId, after the
      // recovery update below has run) sees it cleared - the mock doesn't
      // model real DB mutation, so this models the post-update read directly.
      "calendar_watch_channels:select": [
        {
          data: {
            id: "watch-1", channel_id: "c1", resource_id: "r1",
            sync_token: "stale-sync-token", pending_page_token: null,
            expiration_at: new Date(Date.now() + 999999).toISOString(), status: "ACTIVE",
          },
          error: null,
        },
        {
          data: {
            id: "watch-1", channel_id: "c1", resource_id: "r1",
            sync_token: null, pending_page_token: null,
            expiration_at: new Date(Date.now() + 999999).toISOString(), status: "ACTIVE",
          },
          error: null,
        },
      ],
      "calendar_events:select": [{ data: null, error: null }],
      "calendar_events:upsert": [{ data: { id: "event-row-1" }, error: null }],
      "meetings:select": [{ data: null, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await syncGoogleCalendarConnection("conn-1", { accessToken: "token-x" });

    expect(result).toEqual({ eventCount: 1, syncTokenStored: true, completed: true });
    expect(listCalendarEventsPage).toHaveBeenCalledTimes(2);

    // First attempt used the (now-stale) syncToken.
    expect(vi.mocked(listCalendarEventsPage).mock.calls[0][0]).toMatchObject({ syncToken: "stale-sync-token" });

    // Recovery clears sync_token/pending_page_token before retrying.
    expect(watchUpdateCalls[0]).toMatchObject({ sync_token: null, pending_page_token: null });

    // The retry is a fresh BOUNDED initial query (both timeMin and timeMax
    // set), not another syncToken attempt and not an unbounded one.
    const retryCall = vi.mocked(listCalendarEventsPage).mock.calls[1][0] as {
      syncToken?: string | null;
      initialTimeMin?: string | null;
      initialTimeMax?: string | null;
    };
    expect(retryCall.syncToken).toBeFalsy();
    expect(retryCall.initialTimeMin).toBeTruthy();
    expect(retryCall.initialTimeMax).toBeTruthy();
  });

  it("propagates a second consecutive 410 instead of retrying forever", async () => {
    vi.mocked(listCalendarEventsPage).mockRejectedValue(new GoogleCalendarApiError("events_list", 410));

    const { client } = makeAdminMock({
      "google_connections:select": [{ data: connectionRow, error: null }],
      "organization_memberships:select": [{ data: membershipRow, error: null }],
      "calendar_watch_channels:select": [{
        data: {
          id: "watch-1", channel_id: "c1", resource_id: "r1",
          sync_token: "stale-sync-token", pending_page_token: null,
          expiration_at: new Date(Date.now() + 999999).toISOString(), status: "ACTIVE",
        },
        error: null,
      }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await expect(syncGoogleCalendarConnection("conn-1", { accessToken: "token-x" })).rejects.toThrow();
    // Exactly one retry attempt (retriedAfterGone guards against looping).
    expect(listCalendarEventsPage).toHaveBeenCalledTimes(2);
  });
});

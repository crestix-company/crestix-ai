import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { listCalendarEventsPage } from "@/lib/google/calendar-api";
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
const watchRow = {
  id: "watch-1", channel_id: "c1", resource_id: "r1",
  sync_token: null, pending_page_token: null,
  expiration_at: new Date(Date.now() + 999999).toISOString(), status: "ACTIVE",
};

type Canned = { data?: unknown; error?: unknown };

interface FakeChain extends PromiseLike<Canned> {
  select(...args: unknown[]): FakeChain;
  upsert(payload: unknown, ...rest: unknown[]): FakeChain;
  update(payload: unknown, ...rest: unknown[]): FakeChain;
  eq(...args: unknown[]): FakeChain;
  order(...args: unknown[]): FakeChain;
  limit(...args: unknown[]): FakeChain;
  maybeSingle(): Promise<Canned>;
  single(): Promise<Canned>;
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
      upsert: (payload: unknown) => { rootMethod ??= "upsert"; (calls[`${table}:upsert`] ??= []).push(payload); return chain; },
      update: (payload: unknown) => { rootMethod ??= "update"; (calls[`${table}:update`] ??= []).push(payload); return chain; },
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => resolve(),
      single: () => resolve(),
      then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
    };
    return chain;
  }
  return { client: { from }, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncGoogleCalendarConnection - Medical FS clinic_name/is_handoff", () => {
  it("persists a normalized clinic_name and structured is_handoff for a new Medical E1 event", async () => {
    vi.mocked(listCalendarEventsPage).mockResolvedValueOnce({
      items: [{
        id: "gevent-1",
        summary: "【お打ち合わせ①】渋谷胃腸クリニック 様",
        status: "confirmed",
        description: "役職：院長\n有償認識：有り\nHP URL：https://shibuya-clinic.example.com",
      }],
      nextSyncToken: "sync-token-1",
    });

    const { client, calls } = makeAdminMock({
      "google_connections:select": [{ data: connectionRow, error: null }],
      "organization_memberships:select": [{ data: membershipRow, error: null }],
      "calendar_watch_channels:select": [{ data: watchRow, error: null }],
      "calendar_events:select": [{ data: null, error: null }],
      "calendar_events:upsert": [{ data: { id: "event-row-1" }, error: null }],
      "meetings:select": [{ data: null, error: null }],
      "meetings:upsert": [{ data: { id: "meeting-row-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await syncGoogleCalendarConnection("conn-1", { accessToken: "token-x" });

    const meetingUpsert = calls["meetings:upsert"][0] as Record<string, unknown>;
    expect(meetingUpsert.meeting_type).toBe("E1");
    expect(meetingUpsert.clinic_name).toBe("渋谷胃腸クリニック");
    expect(meetingUpsert.is_handoff).toMatchObject({
      contact_role: "院長",
      paid_awareness: "有り",
      homepage_url: "https://shibuya-clinic.example.com",
    });
  });

  it("does not touch an existing out-of-scope (HD) meeting when its title matches no Medical FS rule", async () => {
    vi.mocked(listCalendarEventsPage).mockResolvedValueOnce({
      items: [{ id: "gevent-2", summary: "【HD①】テスト店舗", status: "confirmed" }],
      nextSyncToken: "sync-token-2",
    });

    const { client, calls } = makeAdminMock({
      "google_connections:select": [{ data: connectionRow, error: null }],
      "organization_memberships:select": [{ data: membershipRow, error: null }],
      "calendar_watch_channels:select": [{ data: watchRow, error: null }],
      "calendar_events:select": [{ data: null, error: null }],
      "calendar_events:upsert": [{ data: { id: "event-row-2" }, error: null }],
      "meetings:select": [{ data: { id: "meeting-hd-1", status: "DETECTED", meeting_type: "HD" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await syncGoogleCalendarConnection("conn-1", { accessToken: "token-x" });

    expect(calls["meetings:update"]).toBeUndefined();
    expect(calls["meetings:upsert"]).toBeUndefined();
  });

  it("still auto-cancels an in-scope (E1/E2) meeting whose title was edited to no longer match", async () => {
    vi.mocked(listCalendarEventsPage).mockResolvedValueOnce({
      items: [{ id: "gevent-3", summary: "普通の打ち合わせ", status: "confirmed" }],
      nextSyncToken: "sync-token-3",
    });

    const { client, calls } = makeAdminMock({
      "google_connections:select": [{ data: connectionRow, error: null }],
      "organization_memberships:select": [{ data: membershipRow, error: null }],
      "calendar_watch_channels:select": [{ data: watchRow, error: null }],
      "calendar_events:select": [{ data: null, error: null }],
      "calendar_events:upsert": [{ data: { id: "event-row-3" }, error: null }],
      "meetings:select": [{ data: { id: "meeting-e1-1", status: "DETECTED", meeting_type: "E1" }, error: null }],
      "meetings:update": [{ data: null, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await syncGoogleCalendarConnection("conn-1", { accessToken: "token-x" });

    expect(calls["meetings:update"]).toEqual([{ status: "CANCELLED" }]);
  });
});

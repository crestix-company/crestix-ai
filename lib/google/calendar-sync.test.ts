import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  listCalendarEventsPage,
  stopCalendarWatch,
  watchCalendarEvents,
} from "@/lib/google/calendar-api";
import { ensureCalendarWatch } from "./calendar-sync";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/google/calendar-api", () => ({
  GoogleCalendarApiError: class GoogleCalendarApiError extends Error {},
  listCalendarEventsPage: vi.fn(),
  refreshGoogleAccessToken: vi.fn(),
  stopCalendarWatch: vi.fn().mockResolvedValue(undefined),
  watchCalendarEvents: vi.fn().mockResolvedValue({
    id: "channel-new",
    resourceId: "resource-new",
    expiration: Date.now() + 7 * 24 * 60 * 60 * 1000,
  }),
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

type Canned = { data?: unknown; error?: unknown };

interface FakeChain extends PromiseLike<Canned> {
  select(...args: unknown[]): FakeChain;
  insert(...args: unknown[]): FakeChain;
  update(...args: unknown[]): FakeChain;
  eq(...args: unknown[]): FakeChain;
  order(...args: unknown[]): FakeChain;
  limit(...args: unknown[]): FakeChain;
  maybeSingle(): Promise<Canned>;
  single(): Promise<Canned>;
}

function makeAdminMock(responses: Record<string, Canned>) {
  function from(table: string): FakeChain {
    let rootMethod: string | null = null;
    const resolve = (): Promise<Canned> =>
      Promise.resolve(responses[`${table}:${rootMethod}`] ?? { data: null, error: null });
    const chain: FakeChain = {
      select: (...[]) => { rootMethod ??= "select"; return chain; },
      insert: (...[]) => { rootMethod ??= "insert"; return chain; },
      update: (...[]) => { rootMethod ??= "update"; return chain; },
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => resolve(),
      single: () => resolve(),
      then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
    };
    return chain;
  }
  return { from };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ensureCalendarWatch", () => {
  it("creates a watch without triggering an inline sync", async () => {
    vi.mocked(createAdminClient).mockReturnValue(makeAdminMock({
      "google_connections:select": { data: connectionRow },
      "organization_memberships:select": { data: membershipRow },
      "calendar_watch_channels:select": { data: null },
      "calendar_watch_channels:insert": { data: { id: "watch-new" } },
    }) as never);

    const result = await ensureCalendarWatch("conn-1", "https://example.test", { accessToken: "token-x" });

    expect(result).toEqual({ watchId: "watch-new", renewed: true });
    expect(watchCalendarEvents).toHaveBeenCalledTimes(1);
    expect(listCalendarEventsPage).not.toHaveBeenCalled();
  });

  it("returns the existing watch without syncing when it is not near expiry and not forced", async () => {
    const farFuture = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminMock({
      "google_connections:select": { data: connectionRow },
      "organization_memberships:select": { data: membershipRow },
      "calendar_watch_channels:select": {
        data: {
          id: "watch-old",
          channel_id: "channel-old",
          resource_id: "resource-old",
          sync_token: null,
          expiration_at: farFuture,
          status: "ACTIVE",
        },
      },
    }) as never);

    const result = await ensureCalendarWatch("conn-1", "https://example.test", { accessToken: "token-x" });

    expect(result).toEqual({ watchId: "watch-old", renewed: false });
    expect(watchCalendarEvents).not.toHaveBeenCalled();
    expect(listCalendarEventsPage).not.toHaveBeenCalled();
  });

  it("forced renewal stops the old channel and creates a new one without syncing", async () => {
    const soon = new Date(Date.now() + 1000).toISOString();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminMock({
      "google_connections:select": { data: connectionRow },
      "organization_memberships:select": { data: membershipRow },
      "calendar_watch_channels:select": {
        data: {
          id: "watch-old",
          channel_id: "channel-old",
          resource_id: "resource-old",
          sync_token: "prior-token",
          expiration_at: soon,
          status: "ACTIVE",
        },
      },
      "calendar_watch_channels:insert": { data: { id: "watch-new" } },
      "calendar_watch_channels:update": { data: null, error: null },
    }) as never);

    const result = await ensureCalendarWatch("conn-1", "https://example.test", {
      accessToken: "token-x",
      force: true,
    });

    expect(result).toEqual({ watchId: "watch-new", renewed: true });
    expect(stopCalendarWatch).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "channel-old",
      resourceId: "resource-old",
    }));
    expect(listCalendarEventsPage).not.toHaveBeenCalled();
  });
});

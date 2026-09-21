import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateStructuredJson } from "@/lib/gemini/client";
import { runMaterialGenerationForMeeting } from "./material-generate";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/server-secrets", () => ({
  getGeminiCredentials: () => ({ apiKey: "test-key", model: "gemini-2.5-flash" }),
}));
vi.mock("@/lib/gemini/client", () => ({
  generateStructuredJson: vi.fn(),
}));

const meetingRow = { id: "meeting-1", status: "READY", fs_user_id: "user-1", calendar_event_id: "event-1" };
const eventRow = { title: "【お打ち合わせ①】テストクリニック 様" };
const readyPreparationRow = {
  id: "prep-1",
  status: "READY",
  facts: [{ statement: "自費診療あり", source_url: "https://example.com/clinic" }],
  hypotheses: [], needs_confirmation: [], clinic_summary: "", current_measures: [],
  medical_services: [], doctor: "", area: "", competitors: [], seo: "", meo: "", portals: [],
  sales_hypotheses: [], proposal_candidates: [], objections: [], recommended_responses: [],
  must_ask: [], withdrawal_conditions: [], key_points: [],
  talk_script_markdown: "# 【事前準備】テストクリニック\n...",
  sources: [{ url: "https://example.com/clinic" }],
};

const validMaterialJson = JSON.stringify({
  title: "資料", executive_summary: "要約",
  slides: [{ title: "1. 医院サマリー", purpose: "", bullets: [], speaker_notes: "", sources: [] }],
  document_markdown: "# 資料",
});

type Canned = { data?: unknown; error?: unknown };

interface FakeChain extends PromiseLike<Canned> {
  select(...args: unknown[]): FakeChain;
  update(...args: unknown[]): FakeChain;
  upsert(...args: unknown[]): FakeChain;
  insert(...args: unknown[]): FakeChain;
  eq(...args: unknown[]): FakeChain;
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
      update: (payload: unknown) => { rootMethod ??= "update"; (calls[`${table}:update`] ??= []).push(payload); return chain; },
      upsert: (payload: unknown) => { rootMethod ??= "upsert"; (calls[`${table}:upsert`] ??= []).push(payload); return chain; },
      insert: (payload: unknown) => { rootMethod ??= "insert"; (calls[`${table}:insert`] ??= []).push(payload); return chain; },
      eq: () => chain,
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

describe("runMaterialGenerationForMeeting", () => {
  it("generates and saves a READY material from an existing READY preparation", async () => {
    vi.mocked(generateStructuredJson).mockResolvedValue({
      rawText: validMaterialJson, usage: { inputTokens: 5, outputTokens: 6 }, model: "gemini-3.8-flash",
    });
    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "meeting_preparations:select": [{ data: readyPreparationRow, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
      "agent_runs:insert": [{ data: { id: "agent-run-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await runMaterialGenerationForMeeting("meeting-1");

    const materialUpserts = calls["meeting_materials:upsert"] as Array<Record<string, unknown>>;
    expect(materialUpserts.map((u) => u.status)).toEqual(["GENERATING", "READY"]);
    expect(materialUpserts[1]).toMatchObject({ title: "資料", preparation_id: "prep-1" });

    const agentRunUpdate = calls["agent_runs:update"][0] as Record<string, unknown>;
    expect(agentRunUpdate.status).toBe("DONE");
  });

  it("re-throws (does not swallow) on a Gemini schema-invalid response, and marks the agent run FAILED", async () => {
    vi.mocked(generateStructuredJson).mockResolvedValue({
      rawText: "これはJSONではありません", usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-3.8-flash",
    });
    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "meeting_preparations:select": [{ data: readyPreparationRow, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
      "agent_runs:insert": [{ data: { id: "agent-run-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    // This is the point-8 fix: unlike the old inline generateMaterialSafely
    // (which swallowed the error and left the job DONE), this must re-throw
    // so the job processor's own attempts/backoff/FAILED lifecycle owns it.
    await expect(runMaterialGenerationForMeeting("meeting-1")).rejects.toThrow();

    const agentRunUpdate = calls["agent_runs:update"][0] as Record<string, unknown>;
    expect(agentRunUpdate.status).toBe("FAILED");
  });

  it("skips without calling Gemini when the meeting was cancelled since enqueue", async () => {
    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: { ...meetingRow, status: "CANCELLED" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await runMaterialGenerationForMeeting("meeting-1");

    expect(generateStructuredJson).not.toHaveBeenCalled();
    expect(calls["meeting_materials:upsert"]).toBeUndefined();
  });

  it("skips without calling Gemini when the preparation is not (or no longer) READY", async () => {
    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "meeting_preparations:select": [{ data: { ...readyPreparationRow, status: "FAILED" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await runMaterialGenerationForMeeting("meeting-1");

    expect(generateStructuredJson).not.toHaveBeenCalled();
    expect(calls["meeting_materials:upsert"]).toBeUndefined();
  });
});

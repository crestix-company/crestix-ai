import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateStructuredJson, researchClinic } from "@/lib/gemini/client";
import { loadAutoPreparationFlag } from "@/lib/preparation/feature-flags";
import { runAutoPreparationForMeeting } from "./auto-generate";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/security/server-secrets", () => ({
  getGeminiCredentials: () => ({ apiKey: "test-key", model: "gemini-2.5-flash" }),
}));
vi.mock("@/lib/gemini/client", () => ({
  researchClinic: vi.fn(),
  generateStructuredJson: vi.fn(),
}));
vi.mock("@/lib/skills/loader", () => ({
  loadMedicalFsE1Skill: vi.fn().mockResolvedValue({
    skillId: "medical-fs-e1-complete",
    skillVersionId: "version-1",
    content: "# SKILL",
    sha256: "abc",
  }),
}));
vi.mock("@/lib/preparation/feature-flags", () => ({
  loadAutoPreparationFlag: vi.fn(),
}));

const enabledFlag = {
  userId: "user-1",
  enabled: true,
  automation_start_at: "2026-09-19T00:00:00.000Z",
  config: { includePrivateCalendarNotes: false, generateMaterials: true },
};

const meetingRow = {
  id: "meeting-1",
  meeting_type: "E1",
  status: "DETECTED",
  scheduled_start_at: "2026-09-20T01:00:00.000Z",
  fs_user_id: "user-1",
  calendar_event_id: "event-1",
};

const eventRow = { title: "【お打ち合わせ①】テストクリニック 様", description: null };

const validPreparationJson = JSON.stringify({
  facts: [{ statement: "自費診療あり", source_url: "https://example.com/clinic" }],
  hypotheses: [], needs_confirmation: [], clinic_summary: "", current_measures: [],
  medical_services: [], doctor: "", area: "", competitors: [], seo: "", meo: "", portals: [],
  sales_hypotheses: [], proposal_candidates: [], objections: [], recommended_responses: [],
  must_ask: [], withdrawal_conditions: [], key_points: [],
  talk_script_markdown: "# 【事前準備】テストクリニック\n...",
  sources: [{ url: "https://example.com/clinic" }],
});

type Canned = { data?: unknown; error?: unknown };

interface FakeChain extends PromiseLike<Canned> {
  select(...args: unknown[]): FakeChain;
  update(...args: unknown[]): FakeChain;
  upsert(...args: unknown[]): FakeChain;
  insert(...args: unknown[]): FakeChain;
  eq(...args: unknown[]): FakeChain;
  neq(...args: unknown[]): FakeChain;
  single(): Promise<Canned>;
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
      update: (payload: unknown) => { rootMethod ??= "update"; (calls[`${table}:update`] ??= []).push(payload); return chain; },
      upsert: (payload: unknown) => { rootMethod ??= "upsert"; (calls[`${table}:upsert`] ??= []).push(payload); return chain; },
      insert: (payload: unknown) => { rootMethod ??= "insert"; (calls[`${table}:insert`] ??= []).push(payload); return chain; },
      eq: () => chain,
      neq: () => chain,
      single: () => resolve(),
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

describe("runAutoPreparationForMeeting", () => {
  it("returns early without calling Gemini when the meeting is no longer eligible", async () => {
    vi.mocked(loadAutoPreparationFlag).mockResolvedValue(null);
    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await runAutoPreparationForMeeting("meeting-1");

    expect(researchClinic).not.toHaveBeenCalled();
    expect(generateStructuredJson).not.toHaveBeenCalled();
    expect(calls["meetings:update"]).toBeUndefined();
  });

  it("saves a READY preparation and enqueues a MATERIAL_GENERATION job on the happy path", async () => {
    // Material generation is no longer run inline (see
    // lib/preparation/material-generate.ts and its own test file) - a
    // successful Preparation only enqueues the independent job.
    vi.mocked(loadAutoPreparationFlag).mockResolvedValue(enabledFlag);
    vi.mocked(researchClinic).mockResolvedValue({
      summary: "調査結果", sources: [{ url: "https://example.com/clinic" }], searchCallCount: 1,
      usage: { inputTokens: 10, outputTokens: 20 }, model: "gemini-2.5-flash-lite",
    });
    vi.mocked(generateStructuredJson).mockResolvedValueOnce({
      rawText: validPreparationJson, usage: { inputTokens: 30, outputTokens: 40 }, model: "gemini-3.8-flash",
    });

    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
      "agent_runs:insert": [{ data: { id: "agent-run-1" }, error: null }],
      "meeting_preparations:select": [{ data: { attempt_count: 0 }, error: null }],
      "meeting_preparations:upsert": [{ data: null, error: null }, { data: { id: "prep-1" }, error: null }],
      "jobs:upsert": [{ data: { id: "material-job-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await runAutoPreparationForMeeting("meeting-1");

    const finalPrep = calls["meeting_preparations:upsert"][1] as Record<string, unknown>;
    expect(finalPrep.status).toBe("READY");
    expect(finalPrep.source_mode).toBe("API");
    expect(finalPrep.attempt_count).toBe(1);

    const meetingsUpdates = calls["meetings:update"] as Array<Record<string, unknown>>;
    expect(meetingsUpdates.map((u) => u.status)).toEqual(["PREPARING", "READY"]);

    // Two stage rows now (RESEARCH, then PREPARATION), both DONE.
    const agentRunUpdates = calls["agent_runs:update"] as Array<Record<string, unknown>>;
    expect(agentRunUpdates).toHaveLength(2);
    expect(agentRunUpdates.every((u) => u.status === "DONE")).toBe(true);

    const materialJobUpserts = calls["jobs:upsert"] as Array<Record<string, unknown>>;
    expect(materialJobUpserts).toHaveLength(1);
    expect(materialJobUpserts[0]).toMatchObject({ job_type: "MATERIAL_GENERATION", meeting_id: "meeting-1" });
    expect(calls["meeting_materials:upsert"]).toBeUndefined();
  });

  it("does not enqueue a MATERIAL_GENERATION job when generateMaterials is disabled", async () => {
    vi.mocked(loadAutoPreparationFlag).mockResolvedValue({
      ...enabledFlag,
      config: { ...enabledFlag.config, generateMaterials: false },
    });
    vi.mocked(researchClinic).mockResolvedValue({
      summary: "調査結果", sources: [], searchCallCount: 0, usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-2.5-flash-lite",
    });
    vi.mocked(generateStructuredJson).mockResolvedValueOnce({
      rawText: validPreparationJson, usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-3.8-flash",
    });

    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
      "agent_runs:insert": [{ data: { id: "agent-run-1" }, error: null }],
      "meeting_preparations:select": [{ data: { attempt_count: 0 }, error: null }],
      "meeting_preparations:upsert": [{ data: null, error: null }, { data: { id: "prep-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await runAutoPreparationForMeeting("meeting-1");

    expect(calls["jobs:upsert"]).toBeUndefined();
  });

  it("re-throws on a preparation (STEP B) failure so the job queue retries, and marks the PREPARATION agent run FAILED", async () => {
    vi.mocked(loadAutoPreparationFlag).mockResolvedValue(enabledFlag);
    vi.mocked(researchClinic).mockResolvedValue({
      summary: "調査結果", sources: [], searchCallCount: 0, usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-2.5-flash-lite",
    });
    vi.mocked(generateStructuredJson).mockResolvedValueOnce({
      rawText: "これはJSONではありません", usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-3.8-flash",
    });

    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
      "agent_runs:insert": [{ data: { id: "agent-run-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await expect(runAutoPreparationForMeeting("meeting-1")).rejects.toThrow();

    // [0] = RESEARCH stage (succeeded, DONE), [1] = PREPARATION stage (failed).
    const agentRunUpdates = calls["agent_runs:update"] as Array<Record<string, unknown>>;
    expect(agentRunUpdates[0].status).toBe("DONE");
    expect(agentRunUpdates[1].status).toBe("FAILED");
    expect(calls["meeting_materials:upsert"]).toBeUndefined();
    expect(calls["jobs:upsert"]).toBeUndefined();
  });

  it("re-throws and marks the RESEARCH agent run FAILED when research itself fails", async () => {
    vi.mocked(loadAutoPreparationFlag).mockResolvedValue(enabledFlag);
    vi.mocked(researchClinic).mockRejectedValue(new Error("gemini_timeout"));

    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
      "agent_runs:insert": [{ data: { id: "agent-run-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await expect(runAutoPreparationForMeeting("meeting-1")).rejects.toThrow("gemini_timeout");

    const agentRunUpdates = calls["agent_runs:update"] as Array<Record<string, unknown>>;
    expect(agentRunUpdates).toHaveLength(1);
    expect(agentRunUpdates[0].status).toBe("FAILED");
  });
});

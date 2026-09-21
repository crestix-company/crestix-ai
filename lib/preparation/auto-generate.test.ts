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

const eventRow = { title: "【お打ち合わせ①】テストクリニック 様", description: null, source_updated_at: "2026-09-19T00:00:00.000Z" };

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
      researchMode: "GROUNDED", groundingStatus: "SUCCESS",
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

    // upsert[0] = initial PREPARING; upsert[1] = Research-stage checkpoint
    // (research_status READY, overall status still PREPARING); upsert[2] =
    // final READY save once Preparation also succeeds.
    const finalPrep = calls["meeting_preparations:upsert"][2] as Record<string, unknown>;
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

  it("uses the persisted clinic_name (not the raw Calendar title) and passes only the sanitized IS handoff into the Preparation prompt", async () => {
    vi.mocked(loadAutoPreparationFlag).mockResolvedValue(enabledFlag);
    vi.mocked(researchClinic).mockResolvedValue({
      summary: "調査結果", sources: [], searchCallCount: 0, usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-2.5-flash-lite",
      researchMode: "GROUNDED", groundingStatus: "SUCCESS",
    });
    vi.mocked(generateStructuredJson).mockResolvedValueOnce({
      rawText: validPreparationJson, usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-3.8-flash",
    });

    const meetingRowWithHandoff = {
      ...meetingRow,
      clinic_name: "渋谷胃腸クリニック",
      is_handoff: {
        appointment_setter: "前田",
        fs_owner: "前川",
        contact_email: "contact@example.com",
        clinic_phone: "03-1234-5678",
        contact_name: "後藤 直樹",
        contact_role: "院長",
        paid_awareness: "有り",
        patient_acceptance: null,
        personality_note: null,
        article_status: null,
        article_url: null,
        concern_exists: null,
        concern_detail: null,
        growth_area: null,
        new_patient_capacity: null,
        prior_outcome: null,
        prior_outcome_detail: null,
        focus_department: null,
        homepage_url: "https://shibuya-clinic.example.com",
        notes: null,
      },
    };

    const { client } = makeAdminMock({
      "meetings:select": [{ data: meetingRowWithHandoff, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
      "agent_runs:insert": [{ data: { id: "agent-run-1" }, error: null }],
      "meeting_preparations:select": [{ data: { attempt_count: 0 }, error: null }],
      "meeting_preparations:upsert": [{ data: null, error: null }, { data: { id: "prep-1" }, error: null }],
      "jobs:upsert": [{ data: { id: "material-job-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await runAutoPreparationForMeeting("meeting-1");

    const preparationPrompt = vi.mocked(generateStructuredJson).mock.calls[0][0];
    expect(preparationPrompt).toContain("渋谷胃腸クリニック");
    expect(preparationPrompt).toContain("担当者の役職: 院長");
    expect(preparationPrompt).toContain("HP URL: https://shibuya-clinic.example.com");
    expect(preparationPrompt).not.toContain("後藤 直樹");
    expect(preparationPrompt).not.toContain("contact@example.com");
    expect(preparationPrompt).not.toContain("03-1234-5678");
    expect(preparationPrompt).not.toContain("前田");
    expect(preparationPrompt).not.toContain("前川");

    const researchPrompt = vi.mocked(researchClinic).mock.calls[0][0];
    expect(researchPrompt.groundedPrompt).toContain("渋谷胃腸クリニック");
    expect(researchPrompt.groundedPrompt).toContain("Calendar記載のHP URL: https://shibuya-clinic.example.com");
  });

  it("does not enqueue a MATERIAL_GENERATION job when generateMaterials is disabled", async () => {
    vi.mocked(loadAutoPreparationFlag).mockResolvedValue({
      ...enabledFlag,
      config: { ...enabledFlag.config, generateMaterials: false },
    });
    vi.mocked(researchClinic).mockResolvedValue({
      summary: "調査結果", sources: [], searchCallCount: 0, usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-2.5-flash-lite",
      researchMode: "GROUNDED", groundingStatus: "SUCCESS",
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
      researchMode: "GROUNDED", groundingStatus: "SUCCESS",
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

  it("reuses a READY Research checkpoint (same event version) instead of re-running Research, when Preparation is retried", async () => {
    vi.mocked(loadAutoPreparationFlag).mockResolvedValue(enabledFlag);
    vi.mocked(generateStructuredJson).mockResolvedValueOnce({
      rawText: validPreparationJson, usage: { inputTokens: 30, outputTokens: 40 }, model: "gemini-3.8-flash",
    });

    const checkpointRow = {
      research_status: "READY",
      research_summary: "以前成功したResearchの結果",
      research_sources: [{ url: "https://example.com/clinic" }],
      research_mode: "GROUNDED",
      grounding_status: "SUCCESS",
      research_model: "gemini-3.5-flash-lite",
      grounding_error_safe: null,
      research_source_updated_at: eventRow.source_updated_at,
      attempt_count: 1,
    };

    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
      "agent_runs:insert": [{ data: { id: "agent-run-preparation" }, error: null }],
      "meeting_preparations:select": [{ data: checkpointRow, error: null }],
      "meeting_preparations:upsert": [{ data: null, error: null }, { data: { id: "prep-1" }, error: null }],
      "jobs:upsert": [{ data: { id: "material-job-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await runAutoPreparationForMeeting("meeting-1");

    expect(researchClinic).not.toHaveBeenCalled();
    expect(generateStructuredJson).toHaveBeenCalledTimes(1);

    // Only one agent_runs row is ever inserted this run: PREPARATION. No
    // fresh RESEARCH row, since the checkpoint was reused.
    const agentRunInserts = calls["agent_runs:insert"] as Array<Record<string, unknown>>;
    expect(agentRunInserts).toHaveLength(1);
    expect(agentRunInserts[0].mode).toBe("PREPARATION");

    const finalPrep = calls["meeting_preparations:upsert"][1] as Record<string, unknown>;
    expect(finalPrep.status).toBe("READY");
    expect(finalPrep.research_summary).toBe(checkpointRow.research_summary);
    expect(finalPrep.research_mode).toBe("GROUNDED");
  });

  it("does not reuse a Research checkpoint once the underlying Calendar event has been edited since (source_updated_at mismatch)", async () => {
    vi.mocked(loadAutoPreparationFlag).mockResolvedValue(enabledFlag);
    vi.mocked(researchClinic).mockResolvedValue({
      summary: "新しいResearch結果", sources: [], searchCallCount: 0, usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-3.5-flash-lite",
      researchMode: "GROUNDED", groundingStatus: "SUCCESS",
    });
    vi.mocked(generateStructuredJson).mockResolvedValueOnce({
      rawText: validPreparationJson, usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-3.8-flash",
    });

    const staleCheckpointRow = {
      research_status: "READY",
      research_summary: "編集前のイベントに対するResearch結果",
      research_sources: [],
      research_mode: "GROUNDED",
      grounding_status: "SUCCESS",
      research_model: "gemini-3.5-flash-lite",
      grounding_error_safe: null,
      research_source_updated_at: "2026-09-18T00:00:00.000Z", // older than eventRow's
      attempt_count: 1,
    };

    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
      "agent_runs:insert": [{ data: { id: "agent-run-1" }, error: null }],
      "meeting_preparations:select": [{ data: staleCheckpointRow, error: null }],
      "meeting_preparations:upsert": [{ data: null, error: null }, { data: { id: "prep-1" }, error: null }],
      "jobs:upsert": [{ data: { id: "material-job-1" }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await runAutoPreparationForMeeting("meeting-1");

    expect(researchClinic).toHaveBeenCalledTimes(1);
    const agentRunInserts = calls["agent_runs:insert"] as Array<Record<string, unknown>>;
    expect(agentRunInserts.map((row) => row.mode)).toEqual(["RESEARCH", "PREPARATION"]);
  });

  it("a Preparation failure after a FRESH Research success never re-marks the already-DONE RESEARCH agent run, and leaves the checkpoint intact for the next retry to reuse", async () => {
    vi.mocked(loadAutoPreparationFlag).mockResolvedValue(enabledFlag);
    vi.mocked(researchClinic).mockResolvedValue({
      summary: "調査結果", sources: [], searchCallCount: 0, usage: { inputTokens: 1, outputTokens: 1 }, model: "gemini-3.5-flash-lite",
      researchMode: "GROUNDED", groundingStatus: "SUCCESS",
    });
    vi.mocked(generateStructuredJson).mockRejectedValueOnce(new Error("gemini_503_high_demand"));

    const { client, calls } = makeAdminMock({
      "meetings:select": [{ data: meetingRow, error: null }],
      "calendar_events:select": [{ data: eventRow, error: null }],
      "agent_runs:insert": [{ data: { id: "agent-run-research" } }, { data: { id: "agent-run-preparation" } }],
      "meeting_preparations:select": [{ data: { attempt_count: 0 }, error: null }],
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await expect(runAutoPreparationForMeeting("meeting-1")).rejects.toThrow("gemini_503_high_demand");

    // Only the PREPARATION agent run is ever marked FAILED - the RESEARCH
    // run (already checkpointed DONE before Preparation was attempted) must
    // never be touched again by this failure.
    const agentRunUpdates = calls["agent_runs:update"] as Array<Record<string, unknown>>;
    expect(agentRunUpdates).toHaveLength(2);
    expect(agentRunUpdates[0].status).toBe("DONE"); // RESEARCH
    expect(agentRunUpdates[1].status).toBe("FAILED"); // PREPARATION only

    // The checkpoint upsert (research_status READY) happened before
    // Preparation was attempted at all.
    const checkpointUpsert = calls["meeting_preparations:upsert"][1] as Record<string, unknown>;
    expect(checkpointUpsert.research_status).toBe("READY");
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

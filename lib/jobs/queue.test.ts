import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueMaterialGenerationJob, enqueueMeetingPreparationJob } from "./queue";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeAdminMock(maybeSingleResult: { data: unknown; error: unknown }) {
  const upsertCalls: Array<{ payload: unknown; options: unknown }> = [];
  const chain = {
    upsert: (payload: unknown, options: unknown) => {
      upsertCalls.push({ payload, options });
      return chain;
    },
    select: () => chain,
    maybeSingle: () => Promise.resolve(maybeSingleResult),
  };
  return { client: { from: () => chain }, upsertCalls };
}

describe("enqueueMeetingPreparationJob", () => {
  it("upserts with an onConflict dedupe key and ignoreDuplicates so a repeat call for the same event version never creates a second row", async () => {
    const { client, upsertCalls } = makeAdminMock({ data: { id: "job-1" }, error: null });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const jobId = await enqueueMeetingPreparationJob({
      meetingId: "meeting-1",
      dedupeKey: "meeting-prep:meeting-1:abc123",
    });

    expect(jobId).toBe("job-1");
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].payload).toMatchObject({
      job_type: "MEETING_PREPARATION",
      meeting_id: "meeting-1",
      dedupe_key: "meeting-prep:meeting-1:abc123",
      status: "PENDING",
    });
    expect(upsertCalls[0].options).toMatchObject({
      onConflict: "dedupe_key",
      ignoreDuplicates: true,
    });
  });

  it("returns null without throwing when the dedupe key already exists (ignoreDuplicates skip -> no row returned)", async () => {
    const { client } = makeAdminMock({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const jobId = await enqueueMeetingPreparationJob({
      meetingId: "meeting-1",
      dedupeKey: "meeting-prep:meeting-1:abc123",
    });

    expect(jobId).toBeNull();
  });

  it("throws on a real database error other than a duplicate-key conflict", async () => {
    const { client } = makeAdminMock({ data: null, error: { code: "42501" } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await expect(enqueueMeetingPreparationJob({
      meetingId: "meeting-1",
      dedupeKey: "meeting-prep:meeting-1:abc123",
    })).rejects.toThrow("meeting_preparation_job_enqueue_failed");
  });
});

describe("enqueueMaterialGenerationJob", () => {
  it("upserts a MATERIAL_GENERATION job carrying preparation_id in payload, keyed by its own dedupe key", async () => {
    const { client, upsertCalls } = makeAdminMock({ data: { id: "job-2" }, error: null });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const jobId = await enqueueMaterialGenerationJob({
      meetingId: "meeting-1",
      preparationId: "prep-1",
      dedupeKey: "material-gen:meeting-1:prep-1:2026-09-20T00:00:00.000Z",
    });

    expect(jobId).toBe("job-2");
    expect(upsertCalls[0].payload).toMatchObject({
      job_type: "MATERIAL_GENERATION",
      meeting_id: "meeting-1",
      payload: { preparation_id: "prep-1" },
      dedupe_key: "material-gen:meeting-1:prep-1:2026-09-20T00:00:00.000Z",
      status: "PENDING",
    });
    expect(upsertCalls[0].options).toMatchObject({
      onConflict: "dedupe_key",
      ignoreDuplicates: true,
    });
  });

  it("returns null without throwing when the dedupe key already exists (regenerating the same preparation version doesn't pile up jobs)", async () => {
    const { client } = makeAdminMock({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const jobId = await enqueueMaterialGenerationJob({
      meetingId: "meeting-1",
      preparationId: "prep-1",
      dedupeKey: "material-gen:meeting-1:prep-1:2026-09-20T00:00:00.000Z",
    });

    expect(jobId).toBeNull();
  });

  it("throws on a real database error other than a duplicate-key conflict", async () => {
    const { client } = makeAdminMock({ data: null, error: { code: "42501" } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await expect(enqueueMaterialGenerationJob({
      meetingId: "meeting-1",
      preparationId: "prep-1",
      dedupeKey: "material-gen:meeting-1:prep-1:2026-09-20T00:00:00.000Z",
    })).rejects.toThrow("material_generation_job_enqueue_failed");
  });
});

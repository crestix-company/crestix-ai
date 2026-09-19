import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueMeetingPreparationJob } from "./queue";

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

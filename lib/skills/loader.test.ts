import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadMedicalFsE1Skill, loadSkill, MEDICAL_FS_E1_SKILL } from "./loader";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

interface Canned { data?: unknown; error?: unknown }

function makeAdminMock(responses: Record<string, Canned>) {
  const calls: Record<string, unknown[]> = {};
  function from(table: string) {
    let rootMethod: string | null = null;
    const resolve = (): Promise<Canned> =>
      Promise.resolve(responses[`${table}:${rootMethod}`] ?? { data: null, error: null });
    const chain = {
      upsert: (payload: unknown) => {
        rootMethod ??= "upsert";
        (calls[table] ??= []).push(payload);
        return chain;
      },
      select: () => chain,
      single: () => resolve(),
      then: (onFulfilled: (v: Canned) => unknown, onRejected?: (e: unknown) => unknown) =>
        resolve().then(onFulfilled, onRejected),
    };
    return chain;
  }
  return { client: { from }, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadSkill", () => {
  it("reads the file, hashes it, and upserts the skill + an immutable version row", async () => {
    const absolutePath = path.join(process.cwd(), MEDICAL_FS_E1_SKILL.filePath);
    const content = await readFile(absolutePath, "utf8");
    const expectedSha256 = createHash("sha256").update(content, "utf8").digest("hex");

    const { client, calls } = makeAdminMock({
      "skills:upsert": { error: null },
      "skill_versions:upsert": { data: { id: "version-1" }, error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await loadSkill(MEDICAL_FS_E1_SKILL);

    expect(result.content).toBe(content);
    expect(result.sha256).toBe(expectedSha256);
    expect(result.skillVersionId).toBe("version-1");
    expect(calls.skills[0]).toMatchObject({
      id: MEDICAL_FS_E1_SKILL.skillId,
      file_path: MEDICAL_FS_E1_SKILL.filePath,
    });
    expect(calls.skill_versions[0]).toMatchObject({
      skill_id: MEDICAL_FS_E1_SKILL.skillId,
      sha256: expectedSha256,
      content,
    });
  });

  it("loadMedicalFsE1Skill loads the master E1 skill", async () => {
    const { client } = makeAdminMock({
      "skills:upsert": { error: null },
      "skill_versions:upsert": { data: { id: "version-2" }, error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const result = await loadMedicalFsE1Skill();
    expect(result.skillId).toBe("medical-fs-e1-complete");
    expect(result.content).toContain("医療FS｜事前準備 → E1トークスクリプト");
  });

  it("throws a safe error when the skill_versions upsert fails", async () => {
    const { client } = makeAdminMock({
      "skills:upsert": { error: null },
      "skill_versions:upsert": { data: null, error: { code: "23505" } },
    });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    await expect(loadSkill(MEDICAL_FS_E1_SKILL)).rejects.toThrow("skill_version_persist_failed");
  });
});

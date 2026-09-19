import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";

export interface LoadedSkill {
  skillId: string;
  skillVersionId: string;
  content: string;
  sha256: string;
}

export const MEDICAL_FS_E1_SKILL = {
  skillId: "medical-fs-e1-complete",
  filePath: "skills/fs/medical-fs-e1-complete/SKILL.md",
  name: "Medical FS E1 Complete",
} as const;

/**
 * Reads the Skill file fresh from disk every call (never hardcode its
 * content elsewhere) and records an immutable skill_versions row keyed by
 * content hash, per skills.md section 4. Upserting on (skill_id, sha256) is
 * idempotent: it only ever re-affirms a version with identical content.
 */
export async function loadSkill(input: {
  skillId: string;
  filePath: string;
  name: string;
}): Promise<LoadedSkill> {
  const absolutePath = path.join(process.cwd(), input.filePath);
  const content = await readFile(absolutePath, "utf8");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");

  const admin = createAdminClient();

  const { error: skillError } = await admin
    .from("skills")
    .upsert({
      id: input.skillId,
      name: input.name,
      file_path: input.filePath,
    }, { onConflict: "id" });
  if (skillError) throw new Error("skill_registry_persist_failed");

  const { data: version, error: versionError } = await admin
    .from("skill_versions")
    .upsert({
      skill_id: input.skillId,
      version_label: sha256.slice(0, 12),
      sha256,
      content,
    }, { onConflict: "skill_id,sha256" })
    .select("id")
    .single();
  if (versionError || !version) throw new Error("skill_version_persist_failed");

  return { skillId: input.skillId, skillVersionId: version.id, content, sha256 };
}

export async function loadMedicalFsE1Skill(): Promise<LoadedSkill> {
  return loadSkill(MEDICAL_FS_E1_SKILL);
}

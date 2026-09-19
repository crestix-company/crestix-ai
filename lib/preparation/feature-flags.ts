import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { FS_AUTO_PREPARATION_FEATURE_KEY, type AutoPreparationFlag } from "@/lib/preparation/auto-eligibility";

export interface AutoPreparationConfig {
  includePrivateCalendarNotes: boolean;
  generateMaterials: boolean;
}

export interface AutoPreparationFlagRow extends AutoPreparationFlag {
  userId: string;
  config: AutoPreparationConfig;
}

function parseConfig(raw: unknown): AutoPreparationConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  return {
    includePrivateCalendarNotes: config.include_private_calendar_notes === true,
    generateMaterials: config.generate_materials !== false,
  };
}

export async function loadAutoPreparationFlag(userId: string): Promise<AutoPreparationFlagRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_feature_flags")
    .select("enabled,automation_start_at,config")
    .eq("user_id", userId)
    .eq("feature_key", FS_AUTO_PREPARATION_FEATURE_KEY)
    .maybeSingle();

  if (error || !data) return null;

  return {
    userId,
    enabled: data.enabled,
    automation_start_at: data.automation_start_at,
    config: parseConfig(data.config),
  };
}

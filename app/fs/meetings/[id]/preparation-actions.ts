"use server";

import { redirect } from "next/navigation";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractJsonObject } from "@/lib/preparation/extract-json";
import { PreparationResultSchema } from "@/lib/preparation/schema";
import { loadMedicalFsE1Skill } from "@/lib/skills/loader";

export async function savePreparationFromPaste(meetingId: string, formData: FormData) {
  await requireAuthorizedUser();
  const supabase = await createClient();

  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id,meeting_type,status")
    .eq("id", meetingId)
    .maybeSingle();

  if (meetingError || !meeting) redirect(`/fs/meetings/${meetingId}?status=prep_forbidden`);
  if (meeting.meeting_type !== "E1") redirect(`/fs/meetings/${meetingId}?status=prep_not_e1`);

  const pastedText = String(formData.get("pastedText") ?? "");
  const parsedJson = extractJsonObject(pastedText);
  if (parsedJson === null) redirect(`/fs/meetings/${meetingId}?status=prep_invalid_json`);

  const validated = PreparationResultSchema.safeParse(parsedJson);
  if (!validated.success) redirect(`/fs/meetings/${meetingId}?status=prep_invalid_json`);

  const admin = createAdminClient();

  let skillVersionId: string | null = null;
  try {
    skillVersionId = (await loadMedicalFsE1Skill()).skillVersionId;
  } catch (skillLoadError) {
    console.error("meeting_preparation_skill_load_failed", {
      meeting_id: meetingId,
      code: skillLoadError instanceof Error ? skillLoadError.message : "unknown",
    });
  }

  const { data: existing } = await admin
    .from("meeting_preparations")
    .select("attempt_count")
    .eq("meeting_id", meetingId)
    .maybeSingle();

  const result = validated.data;

  const { error: upsertError } = await admin
    .from("meeting_preparations")
    .upsert({
      meeting_id: meetingId,
      skill_version_id: skillVersionId,
      status: "READY",
      source_mode: "MANUAL_CHATGPT",
      facts: result.facts,
      hypotheses: result.hypotheses,
      needs_confirmation: result.needs_confirmation,
      clinic_summary: result.clinic_summary,
      current_measures: result.current_measures,
      medical_services: result.medical_services,
      doctor: result.doctor,
      area: result.area,
      competitors: result.competitors,
      seo: result.seo,
      meo: result.meo,
      portals: result.portals,
      sales_hypotheses: result.sales_hypotheses,
      proposal_candidates: result.proposal_candidates,
      objections: result.objections,
      recommended_responses: result.recommended_responses,
      must_ask: result.must_ask,
      withdrawal_conditions: result.withdrawal_conditions,
      key_points: result.key_points,
      talk_script_markdown: result.talk_script_markdown,
      sources: result.sources,
      attempt_count: (existing?.attempt_count ?? 0) + 1,
      error_safe: null,
      generated_at: new Date().toISOString(),
    }, { onConflict: "meeting_id" });

  if (upsertError) {
    console.error("meeting_preparation_save_failed", {
      meeting_id: meetingId,
      db_error_code: upsertError.code,
    });
    redirect(`/fs/meetings/${meetingId}?status=prep_save_failed`);
  }

  if (meeting.status !== "CANCELLED") {
    await admin.from("meetings").update({ status: "READY" }).eq("id", meetingId);
  }

  redirect(`/fs/meetings/${meetingId}?status=prep_saved`);
}

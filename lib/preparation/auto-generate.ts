import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getGeminiCredentials } from "@/lib/security/server-secrets";
import { generateStructuredJson, researchClinic } from "@/lib/gemini/client";
import { loadMedicalFsE1Skill } from "@/lib/skills/loader";
import { isEligibleForAutoPreparation } from "@/lib/preparation/auto-eligibility";
import { loadAutoPreparationFlag } from "@/lib/preparation/feature-flags";
import { buildAutoPreparationPrompt, buildMaterialPrompt, buildResearchPrompt } from "@/lib/preparation/auto-prompt";
import { extractJsonObject } from "@/lib/preparation/extract-json";
import { PreparationResultSchema, type PreparationResult } from "@/lib/preparation/schema";
import { MaterialResultSchema } from "@/lib/preparation/material-schema";

const GEMINI_PROVIDER = "gemini";

interface MeetingRow {
  id: string;
  meeting_type: string;
  status: string;
  scheduled_start_at: string | null;
  fs_user_id: string;
  calendar_event_id: string;
}

interface CalendarEventRow {
  title: string;
  description: string | null;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "unknown_error";
}

async function loadMeetingContext(meetingId: string): Promise<{ meeting: MeetingRow; event: CalendarEventRow }> {
  const admin = createAdminClient();

  const { data: meeting, error: meetingError } = await admin
    .from("meetings")
    .select("id,meeting_type,status,scheduled_start_at,fs_user_id,calendar_event_id")
    .eq("id", meetingId)
    .maybeSingle();
  if (meetingError || !meeting) throw new Error("meeting_preparation_meeting_missing");

  const { data: event, error: eventError } = await admin
    .from("calendar_events")
    .select("title,description")
    .eq("id", meeting.calendar_event_id)
    .maybeSingle();
  if (eventError || !event) throw new Error("meeting_preparation_calendar_event_missing");

  return { meeting: meeting as MeetingRow, event: event as CalendarEventRow };
}

function parsePreparation(rawText: string): PreparationResult {
  const parsedJson = extractJsonObject(rawText);
  if (parsedJson === null) throw new Error("gemini_preparation_response_not_json");

  const validated = PreparationResultSchema.safeParse(parsedJson);
  if (!validated.success) throw new Error("gemini_preparation_response_invalid_schema");

  return validated.data;
}

/**
 * Runs STEP A (research) -> STEP B (Skill-applied structured preparation) ->
 * saves meeting_preparations (source_mode=API) -> STEP C (internal E1
 * material). Material failure is isolated: it never reverts an already
 * READY preparation, per the auto-preparation spec.
 *
 * Re-checks eligibility itself (feature flag / meeting type / cancellation /
 * automation_start_at) rather than trusting the enqueue-time check, since
 * time may have passed between enqueue and a retried run.
 */
export async function runAutoPreparationForMeeting(meetingId: string): Promise<void> {
  const { meeting, event } = await loadMeetingContext(meetingId);

  const flag = await loadAutoPreparationFlag(meeting.fs_user_id);
  const eligible = isEligibleForAutoPreparation({
    meetingType: meeting.meeting_type,
    meetingStatus: meeting.status,
    scheduledStartAt: meeting.scheduled_start_at,
    flag,
  });
  if (!eligible || !flag) return;

  const { model } = getGeminiCredentials();
  const admin = createAdminClient();
  const startedAt = new Date().toISOString();

  await admin.from("meetings").update({ status: "PREPARING" }).eq("id", meetingId).neq("status", "CANCELLED");
  await admin.from("meeting_preparations").upsert({
    meeting_id: meetingId,
    status: "PREPARING",
    source_mode: "API",
  }, { onConflict: "meeting_id" });

  const { data: agentRun } = await admin
    .from("agent_runs")
    .insert({
      meeting_id: meetingId,
      initiated_by_user_id: meeting.fs_user_id,
      mode: "PREPARATION",
      provider: GEMINI_PROVIDER,
      model,
      status: "RUNNING",
      trigger_source: "GOOGLE_CALENDAR",
      started_at: startedAt,
    })
    .select("id")
    .single();

  try {
    const research = await researchClinic(buildResearchPrompt({
      clinicName: event.title,
      calendarTitle: event.title,
      scheduledStartAt: meeting.scheduled_start_at,
    }));

    const skill = await loadMedicalFsE1Skill();

    const generation = await generateStructuredJson(buildAutoPreparationPrompt({
      clinicName: event.title,
      calendarTitle: event.title,
      scheduledStartAt: meeting.scheduled_start_at,
      calendarDescription: event.description,
      includePrivateNotes: flag.config.includePrivateCalendarNotes,
      research,
      skillContent: skill.content,
    }));

    const preparation = parsePreparation(generation.rawText);

    const { data: existing } = await admin
      .from("meeting_preparations")
      .select("attempt_count")
      .eq("meeting_id", meetingId)
      .maybeSingle();

    const { data: savedPreparation, error: saveError } = await admin
      .from("meeting_preparations")
      .upsert({
        meeting_id: meetingId,
        skill_version_id: skill.skillVersionId,
        status: "READY",
        source_mode: "API",
        research_summary: research.summary,
        research_sources: research.sources,
        facts: preparation.facts,
        hypotheses: preparation.hypotheses,
        needs_confirmation: preparation.needs_confirmation,
        clinic_summary: preparation.clinic_summary,
        current_measures: preparation.current_measures,
        medical_services: preparation.medical_services,
        doctor: preparation.doctor,
        area: preparation.area,
        competitors: preparation.competitors,
        seo: preparation.seo,
        meo: preparation.meo,
        portals: preparation.portals,
        sales_hypotheses: preparation.sales_hypotheses,
        proposal_candidates: preparation.proposal_candidates,
        objections: preparation.objections,
        recommended_responses: preparation.recommended_responses,
        must_ask: preparation.must_ask,
        withdrawal_conditions: preparation.withdrawal_conditions,
        key_points: preparation.key_points,
        talk_script_markdown: preparation.talk_script_markdown,
        sources: preparation.sources,
        attempt_count: (existing?.attempt_count ?? 0) + 1,
        error_safe: null,
        generated_at: new Date().toISOString(),
      }, { onConflict: "meeting_id" })
      .select("id")
      .single();

    if (saveError || !savedPreparation) throw new Error("meeting_preparation_save_failed");

    await admin.from("meetings").update({ status: "READY" }).eq("id", meetingId).neq("status", "CANCELLED");

    if (agentRun) {
      await admin.from("agent_runs").update({
        status: "DONE",
        input_tokens: research.usage.inputTokens,
        output_tokens: generation.usage.outputTokens,
        search_call_count: research.searchCallCount,
        completed_at: new Date().toISOString(),
      }).eq("id", agentRun.id);
    }

    if (flag.config.generateMaterials) {
      await generateMaterialSafely({
        meetingId,
        preparationId: savedPreparation.id,
        clinicName: event.title,
        preparation,
      });
    }
  } catch (error) {
    if (agentRun) {
      await admin.from("agent_runs").update({
        status: "FAILED",
        error_safe: safeErrorMessage(error),
        completed_at: new Date().toISOString(),
      }).eq("id", agentRun.id);
    }
    throw error;
  }
}

async function generateMaterialSafely(input: {
  meetingId: string;
  preparationId: string;
  clinicName: string;
  preparation: PreparationResult;
}): Promise<void> {
  const admin = createAdminClient();

  try {
    await admin.from("meeting_materials").upsert({
      meeting_id: input.meetingId,
      preparation_id: input.preparationId,
      status: "GENERATING",
    }, { onConflict: "meeting_id" });

    const generation = await generateStructuredJson(buildMaterialPrompt({
      clinicName: input.clinicName,
      preparationJson: JSON.stringify(input.preparation),
    }));

    const parsedJson = extractJsonObject(generation.rawText);
    if (parsedJson === null) throw new Error("gemini_material_response_not_json");

    const validated = MaterialResultSchema.safeParse(parsedJson);
    if (!validated.success) throw new Error("gemini_material_response_invalid_schema");

    const material = validated.data;

    await admin.from("meeting_materials").upsert({
      meeting_id: input.meetingId,
      preparation_id: input.preparationId,
      status: "READY",
      title: material.title,
      executive_summary: material.executive_summary,
      slides: material.slides,
      document_markdown: material.document_markdown,
      error_safe: null,
      generated_at: new Date().toISOString(),
    }, { onConflict: "meeting_id" });
  } catch (error) {
    console.error("meeting_material_generation_failed", {
      meeting_id: input.meetingId,
      code: safeErrorMessage(error),
    });
    await admin.from("meeting_materials").upsert({
      meeting_id: input.meetingId,
      preparation_id: input.preparationId,
      status: "FAILED",
      error_safe: safeErrorMessage(error),
    }, { onConflict: "meeting_id" });
  }
}

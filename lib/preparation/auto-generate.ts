import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getGeminiCredentials } from "@/lib/security/server-secrets";
import { generateStructuredJson, researchClinic } from "@/lib/gemini/client";
import { estimateCostUsd } from "@/lib/gemini/pricing";
import { loadMedicalFsE1Skill } from "@/lib/skills/loader";
import { isEligibleForAutoPreparation } from "@/lib/preparation/auto-eligibility";
import { loadAutoPreparationFlag } from "@/lib/preparation/feature-flags";
import { buildAutoPreparationPrompt, buildDegradedResearchPrompt, buildResearchPrompt } from "@/lib/preparation/auto-prompt";
import { extractJsonObject } from "@/lib/preparation/extract-json";
import { PreparationResultSchema, type PreparationResult } from "@/lib/preparation/schema";
import { enqueueMaterialGenerationJob } from "@/lib/jobs/queue";

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
 * saves meeting_preparations (source_mode=API) -> enqueues STEP C
 * (MATERIAL_GENERATION job) if enabled. Material generation is NOT run
 * inline: it has its own independent retry lifecycle (see
 * lib/preparation/material-generate.ts) so a Material failure never reverts
 * an already-READY Preparation, and never re-runs (re-bills) Research or
 * Preparation on retry.
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

  const admin = createAdminClient();

  await admin.from("meetings").update({ status: "PREPARING" }).eq("id", meetingId).neq("status", "CANCELLED");
  await admin.from("meeting_preparations").upsert({
    meeting_id: meetingId,
    status: "PREPARING",
    source_mode: "API",
  }, { onConflict: "meeting_id" });

  // Resolved up front only to populate the agent_runs row before the call
  // completes - researchClinic/generateStructuredJson resolve the same
  // (deterministic, env-based) credentials internally for the actual call.
  const { model: researchModel } = getGeminiCredentials("research");

  const { data: researchRun } = await admin
    .from("agent_runs")
    .insert({
      meeting_id: meetingId,
      initiated_by_user_id: meeting.fs_user_id,
      mode: "RESEARCH",
      provider: GEMINI_PROVIDER,
      model: researchModel,
      status: "RUNNING",
      trigger_source: "GOOGLE_CALENDAR",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  let preparationRun: { id: string } | null = null;

  try {
    const researchPromptInput = {
      clinicName: event.title,
      calendarTitle: event.title,
      scheduledStartAt: meeting.scheduled_start_at,
    };
    const research = await researchClinic({
      groundedPrompt: buildResearchPrompt(researchPromptInput),
      degradedPrompt: buildDegradedResearchPrompt(researchPromptInput),
    });

    if (researchRun) {
      // model is re-asserted here (not just at insert time) because a
      // DEGRADED fallback uses a different model (generation-stage) than
      // the research-stage model the row was originally created with.
      await admin.from("agent_runs").update({
        status: "DONE",
        model: research.model,
        input_tokens: research.usage.inputTokens,
        output_tokens: research.usage.outputTokens,
        search_call_count: research.searchCallCount,
        estimated_cost_usd: estimateCostUsd({
          inputTokens: research.usage.inputTokens,
          outputTokens: research.usage.outputTokens,
          searchCallCount: research.searchCallCount,
        }),
        completed_at: new Date().toISOString(),
      }).eq("id", researchRun.id);
    }

    const skill = await loadMedicalFsE1Skill();
    const { model: generationModel } = getGeminiCredentials("generation");

    const { data: insertedPreparationRun } = await admin
      .from("agent_runs")
      .insert({
        meeting_id: meetingId,
        initiated_by_user_id: meeting.fs_user_id,
        skill_version_id: skill.skillVersionId,
        mode: "PREPARATION",
        provider: GEMINI_PROVIDER,
        model: generationModel,
        status: "RUNNING",
        trigger_source: "GOOGLE_CALENDAR",
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    preparationRun = insertedPreparationRun;

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
        research_mode: research.researchMode,
        grounding_status: research.groundingStatus,
        research_model: research.model,
        grounding_error_safe: research.groundingErrorSafe ?? null,
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

    if (preparationRun) {
      await admin.from("agent_runs").update({
        status: "DONE",
        input_tokens: generation.usage.inputTokens,
        output_tokens: generation.usage.outputTokens,
        estimated_cost_usd: estimateCostUsd({
          inputTokens: generation.usage.inputTokens,
          outputTokens: generation.usage.outputTokens,
          searchCallCount: null,
        }),
        completed_at: new Date().toISOString(),
      }).eq("id", preparationRun.id);
    }

    if (flag.config.generateMaterials) {
      // Independent job, independent retry lifecycle (see
      // lib/preparation/material-generate.ts) - a Material failure must
      // never revert this already-READY Preparation. dedupeKey changes with
      // generated_at so a regenerated Preparation gets a fresh Material job
      // rather than colliding with a stale one.
      try {
        await enqueueMaterialGenerationJob({
          meetingId,
          preparationId: savedPreparation.id,
          dedupeKey: `material-gen:${meetingId}:${savedPreparation.id}:${new Date().toISOString()}`,
        });
      } catch (error) {
        console.error("material_generation_job_enqueue_failed", {
          meeting_id: meetingId,
          code: safeErrorMessage(error),
        });
      }
    }
  } catch (error) {
    if (preparationRun) {
      await admin.from("agent_runs").update({
        status: "FAILED",
        error_safe: safeErrorMessage(error),
        completed_at: new Date().toISOString(),
      }).eq("id", preparationRun.id);
    } else if (researchRun) {
      await admin.from("agent_runs").update({
        status: "FAILED",
        error_safe: safeErrorMessage(error),
        completed_at: new Date().toISOString(),
      }).eq("id", researchRun.id);
    }
    throw error;
  }
}

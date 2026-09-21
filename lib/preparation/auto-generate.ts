import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getGeminiCredentials } from "@/lib/security/server-secrets";
import { generateStructuredJson, researchClinic, type GroundingStatus, type ResearchMode, type ResearchResult } from "@/lib/gemini/client";
import { estimateCostUsd } from "@/lib/gemini/pricing";
import { loadMedicalFsE1Skill } from "@/lib/skills/loader";
import { isEligibleForAutoPreparation } from "@/lib/preparation/auto-eligibility";
import { loadAutoPreparationFlag } from "@/lib/preparation/feature-flags";
import { buildAutoPreparationPrompt, buildDegradedResearchPrompt, buildResearchPrompt } from "@/lib/preparation/auto-prompt";
import { extractJsonObject } from "@/lib/preparation/extract-json";
import { sanitizeIsHandoff, type RawIsHandoff } from "@/lib/preparation/is-handoff";
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
  clinic_name: string | null;
  is_handoff: RawIsHandoff | null;
}

interface CalendarEventRow {
  title: string;
  description: string | null;
  source_updated_at: string | null;
}

interface ResearchCheckpointRow {
  research_status: string | null;
  research_summary: string | null;
  research_sources: unknown;
  research_mode: string | null;
  grounding_status: string | null;
  research_model: string | null;
  grounding_error_safe: string | null;
  research_source_updated_at: string | null;
  attempt_count: number | null;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "unknown_error";
}

/** Both null (event has never carried a Google-side updated_at) counts as a match. */
function sameEventVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const aValue = a ?? null;
  const bValue = b ?? null;
  if (aValue === null && bValue === null) return true;
  if (aValue === null || bValue === null) return false;
  return new Date(aValue).getTime() === new Date(bValue).getTime();
}

async function loadMeetingContext(meetingId: string): Promise<{ meeting: MeetingRow; event: CalendarEventRow }> {
  const admin = createAdminClient();

  const { data: meeting, error: meetingError } = await admin
    .from("meetings")
    .select("id,meeting_type,status,scheduled_start_at,fs_user_id,calendar_event_id,clinic_name,is_handoff")
    .eq("id", meetingId)
    .maybeSingle();
  if (meetingError || !meeting) throw new Error("meeting_preparation_meeting_missing");

  const { data: event, error: eventError } = await admin
    .from("calendar_events")
    .select("title,description,source_updated_at")
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
 * Research is stage-checkpointed: as soon as it succeeds, its result is
 * persisted to meeting_preparations (research_status=READY) *before*
 * Preparation is attempted, independent of the row's overall `status`. A
 * retry (e.g. after a transient Preparation-stage failure) reuses that
 * checkpoint instead of re-running - and re-billing - Research, as long as
 * the underlying Calendar event hasn't changed since (research_source_
 * updated_at pinned to calendar_events.source_updated_at).
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

  // clinic_name/is_handoff are computed once at Calendar Sync time (see
  // lib/google/calendar-sync.ts) and persisted on the meeting row - reused
  // here rather than re-parsed, so Research/Preparation/UI/Material all
  // agree on the same normalized clinic name and structured handoff data.
  const clinicName = meeting.clinic_name || event.title;
  const sanitizedIsHandoff = meeting.is_handoff ? sanitizeIsHandoff(meeting.is_handoff) : null;

  const { data: checkpoint } = await admin
    .from("meeting_preparations")
    .select("research_status,research_summary,research_sources,research_mode,grounding_status,research_model,grounding_error_safe,research_source_updated_at,attempt_count")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  const checkpointRow = checkpoint as ResearchCheckpointRow | null;

  await admin.from("meetings").update({ status: "PREPARING" }).eq("id", meetingId).neq("status", "CANCELLED");
  await admin.from("meeting_preparations").upsert({
    meeting_id: meetingId,
    status: "PREPARING",
    source_mode: "API",
  }, { onConflict: "meeting_id" });

  const canReuseResearch = Boolean(
    checkpointRow?.research_status === "READY"
    && checkpointRow.research_summary !== null
    && sameEventVersion(checkpointRow.research_source_updated_at, event.source_updated_at),
  );

  let research: ResearchResult;
  let researchRun: { id: string } | null = null;

  if (canReuseResearch && checkpointRow) {
    research = {
      summary: checkpointRow.research_summary ?? "",
      sources: (checkpointRow.research_sources ?? []) as ResearchResult["sources"],
      searchCallCount: 0,
      usage: { inputTokens: null, outputTokens: null },
      model: checkpointRow.research_model ?? "",
      researchMode: (checkpointRow.research_mode as ResearchMode) ?? "DEGRADED",
      groundingStatus: (checkpointRow.grounding_status as GroundingStatus) ?? "FAILED",
      groundingErrorSafe: checkpointRow.grounding_error_safe ?? undefined,
    };
  } else {
    // Resolved up front only to populate the agent_runs row before the call
    // completes - researchClinic resolves the same (deterministic, env-based)
    // credentials internally for the actual call.
    const { model: researchModel } = getGeminiCredentials("research");

    const { data: insertedResearchRun } = await admin
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
    researchRun = insertedResearchRun;

    try {
      const researchPromptInput = {
        clinicName,
        calendarTitle: event.title,
        scheduledStartAt: meeting.scheduled_start_at,
        homepageUrl: sanitizedIsHandoff?.homepage_url ?? null,
      };
      research = await researchClinic({
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

      // Checkpoint immediately, before Preparation is even attempted: a
      // later Preparation-stage failure must not cost this successful
      // Research.
      await admin.from("meeting_preparations").upsert({
        meeting_id: meetingId,
        status: "PREPARING",
        source_mode: "API",
        research_status: "READY",
        research_summary: research.summary,
        research_sources: research.sources,
        research_mode: research.researchMode,
        grounding_status: research.groundingStatus,
        research_model: research.model,
        grounding_error_safe: research.groundingErrorSafe ?? null,
        research_generated_at: new Date().toISOString(),
        research_source_updated_at: event.source_updated_at,
      }, { onConflict: "meeting_id" });
    } catch (error) {
      if (researchRun) {
        await admin.from("agent_runs").update({
          status: "FAILED",
          error_safe: safeErrorMessage(error),
          completed_at: new Date().toISOString(),
        }).eq("id", researchRun.id);
      }
      try {
        await admin.from("meeting_preparations").update({ research_status: "FAILED" }).eq("meeting_id", meetingId);
      } catch (checkpointError) {
        console.error("research_checkpoint_failure_flag_failed", {
          meeting_id: meetingId,
          code: safeErrorMessage(checkpointError),
        });
      }
      throw error;
    }
  }

  let preparationRun: { id: string } | null = null;

  try {
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
      clinicName,
      calendarTitle: event.title,
      scheduledStartAt: meeting.scheduled_start_at,
      sanitizedIsHandoff,
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
        research_status: "READY",
        research_summary: research.summary,
        research_sources: research.sources,
        research_mode: research.researchMode,
        grounding_status: research.groundingStatus,
        research_model: research.model,
        grounding_error_safe: research.groundingErrorSafe ?? null,
        research_source_updated_at: event.source_updated_at,
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
        today_conclusion: preparation.today_conclusion,
        assumed_outs: preparation.assumed_outs,
        e2_conditions: preparation.e2_conditions,
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
    // Research (fresh or reused) has already fully succeeded and been
    // checkpointed by the time this try block starts - any failure past
    // this point is a Preparation-stage-only failure and must never touch
    // the already-DONE RESEARCH agent_runs row or its checkpoint.
    if (preparationRun) {
      await admin.from("agent_runs").update({
        status: "FAILED",
        error_safe: safeErrorMessage(error),
        completed_at: new Date().toISOString(),
      }).eq("id", preparationRun.id);
    }
    throw error;
  }
}

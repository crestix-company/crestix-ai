import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getGeminiCredentials } from "@/lib/security/server-secrets";
import { generateStructuredJson } from "@/lib/gemini/client";
import { estimateCostUsd } from "@/lib/gemini/pricing";
import { buildMaterialPrompt } from "@/lib/preparation/auto-prompt";
import { extractJsonObject } from "@/lib/preparation/extract-json";
import { MaterialResultSchema } from "@/lib/preparation/material-schema";
import { PreparationResultSchema, type PreparationResult } from "@/lib/preparation/schema";

const GEMINI_PROVIDER = "gemini";

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "unknown_error";
}

/**
 * Independent retry lifecycle from Research/Preparation (see
 * lib/jobs/queue.ts's enqueueMaterialGenerationJob docstring): a Material
 * failure must retry only Material, never re-run (and re-bill) Research or
 * Preparation, and must never revert an already-READY Preparation. Re-checks
 * cancellation/preparation-readiness itself, since time may have passed
 * between enqueue and a retried run.
 */
export async function runMaterialGenerationForMeeting(meetingId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: meeting, error: meetingError } = await admin
    .from("meetings")
    .select("id,status,fs_user_id,calendar_event_id")
    .eq("id", meetingId)
    .maybeSingle();
  if (meetingError || !meeting) throw new Error("material_generation_meeting_missing");
  if (meeting.status === "CANCELLED") return;

  const { data: preparationRow, error: preparationError } = await admin
    .from("meeting_preparations")
    .select("id,status,facts,hypotheses,needs_confirmation,clinic_summary,current_measures,medical_services,doctor,area,competitors,seo,meo,portals,sales_hypotheses,proposal_candidates,objections,recommended_responses,must_ask,withdrawal_conditions,key_points,talk_script_markdown,sources")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (preparationError || !preparationRow) throw new Error("material_generation_preparation_missing");
  if (preparationRow.status !== "READY") return;

  const { data: event, error: eventError } = await admin
    .from("calendar_events")
    .select("title")
    .eq("id", meeting.calendar_event_id)
    .maybeSingle();
  if (eventError || !event) throw new Error("material_generation_calendar_event_missing");

  const preparation = PreparationResultSchema.parse({
    facts: preparationRow.facts,
    hypotheses: preparationRow.hypotheses,
    needs_confirmation: preparationRow.needs_confirmation,
    clinic_summary: preparationRow.clinic_summary,
    current_measures: preparationRow.current_measures,
    medical_services: preparationRow.medical_services,
    doctor: preparationRow.doctor,
    area: preparationRow.area,
    competitors: preparationRow.competitors,
    seo: preparationRow.seo,
    meo: preparationRow.meo,
    portals: preparationRow.portals,
    sales_hypotheses: preparationRow.sales_hypotheses,
    proposal_candidates: preparationRow.proposal_candidates,
    objections: preparationRow.objections,
    recommended_responses: preparationRow.recommended_responses,
    must_ask: preparationRow.must_ask,
    withdrawal_conditions: preparationRow.withdrawal_conditions,
    key_points: preparationRow.key_points,
    talk_script_markdown: preparationRow.talk_script_markdown,
    sources: preparationRow.sources,
  } satisfies Partial<PreparationResult> as PreparationResult);

  const { model } = getGeminiCredentials("generation");
  const startedAt = new Date().toISOString();

  const { data: agentRun } = await admin
    .from("agent_runs")
    .insert({
      meeting_id: meetingId,
      initiated_by_user_id: meeting.fs_user_id,
      mode: "MATERIAL",
      provider: GEMINI_PROVIDER,
      model,
      status: "RUNNING",
      trigger_source: "MATERIAL_GENERATION_JOB",
      started_at: startedAt,
    })
    .select("id")
    .single();

  try {
    await admin.from("meeting_materials").upsert({
      meeting_id: meetingId,
      preparation_id: preparationRow.id,
      status: "GENERATING",
    }, { onConflict: "meeting_id" });

    const generation = await generateStructuredJson(buildMaterialPrompt({
      clinicName: event.title,
      preparationJson: JSON.stringify(preparation),
    }));

    const parsedJson = extractJsonObject(generation.rawText);
    if (parsedJson === null) throw new Error("gemini_material_response_not_json");

    const validated = MaterialResultSchema.safeParse(parsedJson);
    if (!validated.success) throw new Error("gemini_material_response_invalid_schema");

    const material = validated.data;

    await admin.from("meeting_materials").upsert({
      meeting_id: meetingId,
      preparation_id: preparationRow.id,
      status: "READY",
      title: material.title,
      executive_summary: material.executive_summary,
      slides: material.slides,
      document_markdown: material.document_markdown,
      error_safe: null,
      generated_at: new Date().toISOString(),
    }, { onConflict: "meeting_id" });

    if (agentRun) {
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
      }).eq("id", agentRun.id);
    }
  } catch (error) {
    if (agentRun) {
      await admin.from("agent_runs").update({
        status: "FAILED",
        error_safe: safeErrorMessage(error),
        completed_at: new Date().toISOString(),
      }).eq("id", agentRun.id);
    }
    // Re-throw (unlike the old inline generateMaterialSafely, which
    // swallowed this): the job processor's own attempts/backoff/FAILED
    // lifecycle must own Material retries, independent of Preparation's.
    throw error;
  }
}

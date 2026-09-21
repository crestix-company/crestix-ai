"use server";

import { redirect } from "next/navigation";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Live Assist Lite (FS scope spec section 13/14): lets the FS user record
 * which OUT actually came up during the live meeting, without needing
 * real-time transcript/STT analysis. Visibility is checked via the
 * RLS-respecting client first (same pattern as retryMaterialGeneration in
 * material/actions.ts) before the write, which goes through the admin
 * client since authenticated has no direct INSERT grant on this table.
 */
export async function recordActualOut(meetingId: string, formData: FormData) {
  const user = await requireAuthorizedUser();

  const supabase = await createClient();
  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .maybeSingle();
  if (meetingError || !meeting) redirect(`/fs/meetings/${meetingId}?status=out_forbidden`);

  const actualOut = String(formData.get("actualOut") ?? "").trim();
  if (!actualOut) redirect(`/fs/meetings/${meetingId}?status=out_invalid`);

  const responseUsed = String(formData.get("responseUsed") ?? "").trim() || null;
  const memo = String(formData.get("memo") ?? "").trim() || null;
  const resolved = formData.get("resolved") === "on";

  const admin = createAdminClient();

  const { error: insertError } = await admin.from("meeting_out_actuals").insert({
    meeting_id: meetingId,
    actual_out: actualOut,
    response_used: responseUsed,
    memo,
    resolved,
    created_by_user_id: user.id,
  });

  if (insertError) {
    console.error("meeting_out_actual_save_failed", {
      meeting_id: meetingId,
      db_error_code: insertError.code,
    });
    redirect(`/fs/meetings/${meetingId}?status=out_save_failed`);
  }

  redirect(`/fs/meetings/${meetingId}?status=out_saved`);
}

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppOrigin } from "@/lib/auth/app-origin";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { ensureCalendarWatch, safeCalendarErrorCode } from "@/lib/google/calendar-sync";
import { createClient } from "@/lib/supabase/server";

export async function repairGoogleCalendarConnection() {
  const user = await requireAuthorizedUser();
  const supabase = await createClient();

  const { data: connection, error } = await supabase
    .from("google_connections")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !connection) {
    redirect("/settings/connections?status=connection_missing");
  }

  const requestHeaders = await headers();
  let appOrigin: string;
  try {
    appOrigin = getAppOrigin(requestHeaders);
  } catch {
    redirect("/settings/connections?status=origin_unavailable");
  }

  try {
    await ensureCalendarWatch(connection.id, appOrigin, { force: true });
  } catch (error) {
    console.error("calendar_manual_repair_failed", {
      connection_id: connection.id,
      code: safeCalendarErrorCode(error),
    });
    redirect("/settings/connections?status=repair_failed");
  }

  redirect("/settings/connections?status=ready");
}

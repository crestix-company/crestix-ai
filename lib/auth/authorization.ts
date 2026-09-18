import { redirect } from "next/navigation";
import { hasPublicEnv } from "@/lib/config/env";
import { createClient } from "@/lib/supabase/server";

export type MembershipRole = "ADMIN" | "FS_MANAGER" | "FS_MEMBER";

export interface AuthorizedUser {
  id: string;
  email: string;
  displayName: string | null;
  organizationId: string;
  role: MembershipRole;
}

export async function requireAuthorizedUser(): Promise<AuthorizedUser> {
  if (!hasPublicEnv()) redirect("/login?error=not_configured");

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (claimsError || typeof userId !== "string") redirect("/login");

  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, role, profiles!inner(email, display_name)")
    .eq("user_id", userId)
    .eq("department", "FIRST_DIVISION")
    .eq("team", "FS")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) redirect("/login?error=not_authorized");
  const profile = Array.isArray(data.profiles) ? data.profiles[0] : data.profiles;

  return {
    id: userId,
    email: profile.email,
    displayName: profile.display_name,
    organizationId: data.organization_id,
    role: data.role as MembershipRole,
  };
}

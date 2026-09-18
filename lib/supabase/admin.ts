import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getPublicEnv } from "@/lib/config/env";
import { getSupabaseServerKey } from "@/lib/security/server-secrets";

export function createAdminClient() {
  const env = getPublicEnv();
  return createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, getSupabaseServerKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

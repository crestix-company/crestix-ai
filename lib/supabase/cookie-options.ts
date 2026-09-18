export function getSupabaseCookieOptions(isDevelopment: boolean) {
  return {
    path: "/",
    sameSite: "lax" as const,
    secure: !isDevelopment,
  };
}

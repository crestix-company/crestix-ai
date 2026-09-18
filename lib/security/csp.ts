export function buildContentSecurityPolicy(isDevelopment: boolean): string {
  const scriptSource = `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    scriptSource,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' https://*.supabase.co${isDevelopment ? " ws://localhost:* ws://127.0.0.1:*" : ""}`,
    "upgrade-insecure-requests",
  ].join("; ");
}

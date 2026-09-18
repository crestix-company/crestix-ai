export function getOAuthCallbackUrl(origin: string): string {
  return new URL("/auth/callback", origin).toString();
}

export function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname.toLowerCase());
}

export function resolveAppOrigin(input: {
  requestOrigin: string | null;
  host: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  isDevelopment: boolean;
  vercelHost?: string;
  productionHost?: string;
  isVercel?: boolean;
}): string {
  const host = input.host?.toLowerCase();
  const forwardedHost = input.forwardedHost?.toLowerCase();
  if (!host || /[,\s/@\\]/.test(host) || (forwardedHost && forwardedHost !== host)) {
    throw new Error("OAuth host is missing or inconsistent");
  }
  const protocol = input.isDevelopment ? "http:" : "https:";
  if (input.forwardedProto && input.forwardedProto !== protocol.slice(0, -1)) {
    throw new Error("OAuth forwarded protocol is inconsistent");
  }
  const url = new URL(`${protocol}//${host}`);
  if (url.host !== host || (input.isDevelopment && !isLoopbackHost(url.hostname)) ||
    (!input.isDevelopment && isLoopbackHost(url.hostname))) {
    throw new Error("OAuth host is not allowed");
  }
  if (input.isVercel && !input.isDevelopment &&
    host !== input.vercelHost?.toLowerCase() &&
    host !== input.productionHost?.toLowerCase() &&
    !url.hostname.endsWith(".vercel.app")) {
    throw new Error("OAuth host is not a Vercel deployment domain");
  }
  if (input.requestOrigin && input.requestOrigin !== url.origin) {
    throw new Error("OAuth request origin does not match host");
  }
  return url.origin;
}

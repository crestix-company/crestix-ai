import type { NextConfig } from "next";
import { buildContentSecurityPolicy } from "./lib/security/csp";

const securityHeaders = [
  { key: "Content-Security-Policy", value: buildContentSecurityPolicy(process.env.NODE_ENV === "development") },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
  // Skill files are read dynamically (fs.readFile) at request time, so
  // Next.js's static import/require tracer never sees them and omits them
  // from the deployed serverless bundle. Force-include them explicitly.
  outputFileTracingIncludes: {
    "/fs/meetings/\\[id\\]": ["skills/**/*"],
    "/*": ["skills/**/*"],
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;

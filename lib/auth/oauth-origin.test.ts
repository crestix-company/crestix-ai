import { describe, expect, it } from "vitest";
import { getOAuthCallbackUrl, resolveAppOrigin } from "./oauth-redirect";

const base = {
  requestOrigin: null,
  forwardedHost: null,
  forwardedProto: "https",
  isDevelopment: false,
  isVercel: true,
};

describe("Vercel OAuth origin", () => {
  it("uses the current preview host, including the forwarded host", () => {
    const host = "crestix-ai-git-test-team.vercel.app";
    const origin = resolveAppOrigin({ ...base, host, forwardedHost: host, requestOrigin: `https://${host}`, vercelHost: host });
    expect(getOAuthCallbackUrl(origin)).toBe(`https://${host}/auth/callback`);
  });

  it("accepts the production custom domain supplied by Vercel", () => {
    expect(resolveAppOrigin({ ...base, host: "ai.crestix-inc.com", productionHost: "ai.crestix-inc.com" }))
      .toBe("https://ai.crestix-inc.com");
  });

  it("allows loopback HTTP only in development", () => {
    expect(resolveAppOrigin({ ...base, host: "localhost:3000", requestOrigin: "http://localhost:3000", isDevelopment: true, forwardedProto: "http" }))
      .toBe("http://localhost:3000");
    expect(() => resolveAppOrigin({ ...base, host: "localhost:3000" })).toThrow();
    expect(() => resolveAppOrigin({ ...base, host: "127.0.0.1:3000" })).toThrow();
  });

  it("fails closed on inconsistent proxy headers or an unapproved domain", () => {
    const host = "crestix-ai-git-test-team.vercel.app";
    expect(() => resolveAppOrigin({ ...base, host, forwardedHost: "evil.example" })).toThrow();
    expect(() => resolveAppOrigin({ ...base, host, forwardedProto: "http" })).toThrow();
    expect(() => resolveAppOrigin({ ...base, host, requestOrigin: "https://evil.example" })).toThrow();
    expect(() => resolveAppOrigin({ ...base, host: "evil.example" })).toThrow();
  });
});

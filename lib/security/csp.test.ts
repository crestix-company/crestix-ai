import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "./csp";

describe("buildContentSecurityPolicy", () => {
  it("permits eval only for the Next.js development runtime", () => {
    expect(buildContentSecurityPolicy(true)).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(buildContentSecurityPolicy(true)).toContain("ws://localhost:*");
  });

  it("forbids eval in staging and production builds", () => {
    expect(buildContentSecurityPolicy(false)).toContain("script-src 'self' 'unsafe-inline'");
    expect(buildContentSecurityPolicy(false)).not.toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy(false)).not.toContain("ws://localhost:*");
  });
});

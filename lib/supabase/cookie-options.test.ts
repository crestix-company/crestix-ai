import { describe, expect, it } from "vitest";
import { getSupabaseCookieOptions } from "./cookie-options";

describe("getSupabaseCookieOptions", () => {
  it("uses same-origin-compatible cookies on localhost", () => {
    expect(getSupabaseCookieOptions(true)).toEqual({ path: "/", sameSite: "lax", secure: false });
  });

  it("requires HTTPS cookies for staging and production", () => {
    expect(getSupabaseCookieOptions(false)).toEqual({ path: "/", sameSite: "lax", secure: true });
  });
});

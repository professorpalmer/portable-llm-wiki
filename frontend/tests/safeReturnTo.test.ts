import { describe, it, expect } from "vitest";

import { loginReturnTo } from "@/lib/safeReturnTo";

describe("loginReturnTo", () => {
  it("returns pathname only and strips share, t, return, nonce", () => {
    expect(
      loginReturnTo(
        "https://portablellm.wiki/cary/owner?share=abc&t=secret&return=http://127.0.0.1:9/api/wiki/connect&nonce=n1",
      ),
    ).toBe("/cary/owner");
  });

  it("keeps a bare path", () => {
    expect(loginReturnTo("/connect/marionette")).toBe("/connect/marionette");
  });

  it("falls back to / on an unparseable href", () => {
    expect(loginReturnTo("http://")).toBe("/");
  });
});

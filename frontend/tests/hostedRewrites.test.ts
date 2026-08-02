/**
 * Regression tests for hosted-mode Next.js rewrite boundaries.
 *
 * The owner API proxy must only match /:tenant/owner/<subpath> so the exact
 * /:tenant/owner URL continues to serve the app-router owner console.
 */
import { describe, it, expect } from "vitest";
import {
  buildHostedRewrites,
  HOSTED_OWNER_API_SOURCE,
} from "../lib/hostedRewrites.mjs";

describe("hosted owner API rewrite boundary", () => {
  it("requires at least one owner subpath segment (:path+, not :path*)", () => {
    expect(HOSTED_OWNER_API_SOURCE).toBe("/:tenant/owner/:path+");
    expect(HOSTED_OWNER_API_SOURCE).not.toContain(":path*");
  });

  it("proxies owner API subpaths to the tenant-scoped backend route", () => {
    const rewrites = buildHostedRewrites("http://localhost:8000");
    const ownerRewrite = rewrites.find((r) => r.source === HOSTED_OWNER_API_SOURCE);
    expect(ownerRewrite).toEqual({
      source: "/:tenant/owner/:path+",
      destination: "http://localhost:8000/t/:tenant/owner/:path+",
    });
  });

  it("does not add a rewrite for the exact /:tenant/owner console URL", () => {
    const rewrites = buildHostedRewrites("http://localhost:8000");
    const exactOwnerRewrite = rewrites.find(
      (r) => r.source === "/:tenant/owner" || r.source.endsWith("/owner"),
    );
    expect(exactOwnerRewrite).toBeUndefined();
  });
});

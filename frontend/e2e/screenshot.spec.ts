/**
 * Doc-generator spec. NOT a smoke test — this captures hero screenshots
 * for the README. Run with:
 *
 *   npx playwright test e2e/screenshot.spec.ts --project=chromium
 *
 * The output PNGs land in `docs/hero.png` and `docs/hero-mobile.png` in
 * the repo root so the README's hero image is always current.
 *
 * Skipped by default in CI (controlled via the `PLAYWRIGHT_SCREENSHOT`
 * env var) because:
 *   - It requires a running dev backend on :8000 (the streaming demo
 *     would otherwise show the fallback answer, which is fine for
 *     smoke tests but bad for marketing screenshots).
 *   - Re-committing PNGs on every CI run would bloat the diff history.
 *
 * To regenerate locally:
 *
 *   PLAYWRIGHT_SCREENSHOT=1 npx playwright test e2e/screenshot.spec.ts
 *   git add docs/hero.png docs/hero-mobile.png
 *   git commit -m "docs: refresh hero screenshots"
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const ENABLED = process.env.PLAYWRIGHT_SCREENSHOT === "1";

// Default to the production demo URL so screenshots reflect what a
// fresh visitor sees (Avery Chen seed), NOT whatever the local dev
// backend is pointing at. Override with PLAYWRIGHT_SCREENSHOT_URL for
// local debugging.
const TARGET_URL =
  process.env.PLAYWRIGHT_SCREENSHOT_URL ||
  "https://portablellm.wiki/";

test.describe("hero screenshots (doc generator)", () => {
  test.skip(!ENABLED, "set PLAYWRIGHT_SCREENSHOT=1 to regenerate");

  test("desktop hero", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(TARGET_URL);
    await expect(page.locator("body")).toContainText("Your context");
    // Wait for the streaming demo to complete. Sequence per HeroStream:
    //   ~2s of typewriter animation (38ms/char × ~50 chars)
    //   ~3–6s of SSE token streaming
    //   ~500ms for the citations fade-in
    // 10s is a comfortable buffer; the page is otherwise static so the
    // extra time isn't a problem.
    await page.waitForTimeout(10_000);
    await page.screenshot({
      path: path.resolve(__dirname, "..", "..", "docs", "hero.png"),
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });
  });

  test("mobile hero", async ({ page }) => {
    await page.setViewportSize({ width: 414, height: 896 });
    await page.goto(TARGET_URL);
    await expect(page.locator("body")).toContainText("Your context");
    await page.waitForTimeout(10_000);
    await page.screenshot({
      path: path.resolve(__dirname, "..", "..", "docs", "hero-mobile.png"),
      fullPage: false,
      clip: { x: 0, y: 0, width: 414, height: 896 },
    });
  });
});

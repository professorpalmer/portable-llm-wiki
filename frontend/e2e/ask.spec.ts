import { test, expect } from "@playwright/test";

// Smoke: /ask is the most-trafficked interactive surface. This test asserts
// the browser → frontend → backend → wiki round-trip works end-to-end.
//
// REQUIREMENTS:
//   - Backend must be running on http://localhost:8000 (the dev rewrite
//     in next.config.mjs proxies /api/backend/* to it).
//   - The wiki the backend is pointing at must have at least one page so
//     the LLM has something to work with. (The keyword-fallback path also
//     produces a real answer, so no LLM API key is required.)
//
// If you see this fail with a network error in the chat bubble, that's the
// signal that the backend isn't up. See README → "Running E2E tests".

test("submits a question and shows the conversation turn", async ({ page }) => {
  await page.goto("/ask");

  const textarea = page.getByPlaceholder(/ask a question/i);
  await expect(textarea).toBeVisible();
  await textarea.fill("What pages are in this wiki?");

  // Submit via Cmd+Enter (the page binds both Cmd and Ctrl).
  await textarea.press("Meta+Enter");

  // 1) The user bubble appears immediately with the question text.
  await expect(
    page.getByText("What pages are in this wiki?", { exact: true }),
  ).toBeVisible({ timeout: 5_000 });

  // 2) Either a thinking indicator OR an assistant bubble appears within 30s.
  //    The keyword fallback returns in <1s; LLM backends may take longer.
  //    Note: "thinking…" appears in both the inline indicator span AND the
  //    disabled submit button while pending, so we .first() to avoid a
  //    strict-mode multi-match.
  const thinking = page.getByText(/thinking…/i).first();
  // Assistant bubbles render with a "backend:" footer; that text is unique
  // to a completed assistant turn.
  const assistantFooter = page.getByText(/^backend:/i).first();
  await expect(thinking.or(assistantFooter)).toBeVisible({ timeout: 30_000 });
});

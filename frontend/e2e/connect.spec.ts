import { test, expect } from "@playwright/test";

// Smoke: /connect is the setup-guide page. Six client tabs. We assert all
// six are present and that clicking iPhone reveals the Shortcuts walkthrough
// content.

test("connect page shows all 6 tabs and switches to iPhone walkthrough", async ({
  page,
}) => {
  await page.goto("/connect");

  // The six expected client tabs. The visible label may include subtitle
  // text (e.g. "HTTP / .well-known"), so we match by partial text.
  const TAB_LABELS = [
    /claude desktop/i,
    /^cursor/i,
    /chatgpt/i,
    /^iphone/i,
    /any llm/i, // "Any LLM" is the HTTP tab
    /terminal/i,
  ];

  for (const label of TAB_LABELS) {
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  }

  // Click the iPhone tab and assert the Shortcuts walkthrough renders.
  await page.getByRole("button", { name: /^iphone/i }).click();
  await expect(
    page.getByText(/open shortcuts\.app on your iphone/i),
  ).toBeVisible();
  // And the curl example block (used in the "verify the wire" step) renders.
  await expect(page.getByText(/\/owner\/capture\/paste/i).first()).toBeVisible();
});

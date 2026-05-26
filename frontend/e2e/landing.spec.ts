import { test, expect } from "@playwright/test";

// Smoke: the landing page (/) is the front door. If this breaks, every demo
// breaks. Two tiny assertions: the brand text is visible, and the inline
// "Ask the wiki" demo input is interactive.

test.describe("landing page", () => {
  test("renders the brand and hero", async ({ page }) => {
    await page.goto("/");
    // Brand text lives in the NavBar — visible on every route.
    await expect(
      page.getByRole("link", { name: /portable llm wiki/i }),
    ).toBeVisible();
    // Hero copy on the landing itself.
    await expect(
      page.getByRole("heading", { name: /portable across every llm/i }),
    ).toBeVisible();
  });

  test("inline ask demo input is present and focusable", async ({ page }) => {
    await page.goto("/");
    const input = page.getByPlaceholder(
      "What does Avery believe about boring tools?",
    );
    await expect(input).toBeVisible();
    await input.click();
    await expect(input).toBeFocused();
    await input.fill("hello");
    await expect(input).toHaveValue("hello");
  });
});

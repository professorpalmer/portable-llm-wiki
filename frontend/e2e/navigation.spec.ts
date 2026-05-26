import { test, expect, type Page } from "@playwright/test";

// Smoke: every top-level route renders without a Next.js runtime-error
// overlay. We don't validate content here — just that each page boots and
// no uncaught error sneaks in.

const ROUTES = ["/browse", "/graph", "/ask", "/connect"] as const;

async function assertNoRuntimeError(page: Page) {
  // Next.js dev overlay renders an iframe / element with this text on a
  // runtime / build error. We just want to make sure we never see it.
  await expect(page.getByText(/application error/i)).toHaveCount(0);
  await expect(page.getByText(/unhandled runtime error/i)).toHaveCount(0);
}

test("navigates through every top-level route without a runtime error", async ({
  page,
}) => {
  await page.goto("/");
  await assertNoRuntimeError(page);

  for (const href of ROUTES) {
    // Click the NavBar link (desktop). It's unique because the NavBar lives
    // in the layout and we're at viewport size that shows desktop nav.
    const link = page
      .locator("header")
      .getByRole("link", { name: new RegExp(`^${href.slice(1)}$`, "i") });
    await link.click();
    await page.waitForURL(new RegExp(`${href}(/|$)`));
    await assertNoRuntimeError(page);
    // Sanity: page actually rendered something for that route.
    await expect(page.locator("main")).toBeVisible();
  }
});

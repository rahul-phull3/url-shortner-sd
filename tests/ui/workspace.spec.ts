import { test, expect } from "@playwright/test";
test("creates a link, preserves it across reload, shows validation, and revokes it", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Create short link" }),
  ).toBeEnabled();
  await page
    .getByLabel("Destination URL")
    .fill("https://example.com/browser-guide");
  const alias = `browser-${testInfo.project.name}-${Date.now()}`;
  await page.getByLabel("Custom alias").fill(alias);
  await page.getByRole("button", { name: "Create short link" }).click();
  await expect(page.locator(".created-result")).toContainText(`/r/${alias}`);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Destination URL").fill("http://example.com/unsafe");
  await page.getByLabel("Custom alias").fill("");
  await page.getByRole("button", { name: "Create short link" }).click();
  await expect(page.getByRole("alert")).toContainText("public HTTPS");
  await expect(page.getByLabel("Destination URL")).toHaveValue(
    "http://example.com/unsafe",
  );
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-workspace.png`,
    fullPage: true,
  });
  const width = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(width.page).toBeLessThanOrEqual(width.viewport);
  await page
    .getByRole("button", { name: `Revoke ${alias}`, exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator("tbody tr .badge")).toHaveText("revoked");
  const response = await page.request.get(`/r/${alias}`, { maxRedirects: 0 });
  expect(response.status()).toBe(410);
  expect(errors).toEqual([]);
});

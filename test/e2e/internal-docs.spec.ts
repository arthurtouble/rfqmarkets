// Internal manual (apps/internal-docs): every docs/**/*.md as a page with its own URL.
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures.js";
import { urls } from "./stack.js";

/** The manual's navigation; on phones it sits in a drawer behind the menu button. */
async function openNav(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole("button", { name: "Open navigation" }).click();
  const nav = page.getByRole("navigation", { name: "Manual" });
  await expect(nav).toBeVisible();
  return nav;
}

test.describe("internal manual", () => {
  test("opens on the start page and navigates by URL, with Back and reload", async ({ page, isMobile }) => {
    await page.goto(urls.internalDocs);
    await expect(page.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole("article").getByRole("link", { name: "Overview" }).click();
    await expect(page).toHaveURL(/\/architecture\/overview$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("consolidated architecture");
    await expectNoHorizontalOverflow(page);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("consolidated architecture");
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();

    const nav = await openNav(page, isMobile);
    await nav.getByRole("link", { name: "Local application prototype" }).click();
    await expect(page).toHaveURL(/\/operations\//);
    if (isMobile) await expect(page.getByRole("navigation", { name: "Manual" })).toBeHidden();
    await expect(page.getByRole("link", { name: "View source" })).toHaveAttribute(
      "href",
      /github\.com\/.*\/docs\/operations\//,
    );
  });

  test("links to other repository files open on GitHub", async ({ page }) => {
    await page.goto(`${urls.internalDocs}/`);
    const history = page.getByRole("article").getByRole("link", { name: "history/" });
    await expect(history).toHaveAttribute("href", /^https:\/\/github\.com\/.+\/tree\/main\/docs\/history$/);
    await expect(history).toHaveAttribute("target", "_blank");
    await page.getByRole("article").getByRole("link", { name: "takeover/" }).click();
    await expect(page).toHaveURL(/\/takeover$/);
  });

  test("searches every page", async ({ page, isMobile }) => {
    await page.goto(urls.internalDocs);
    if (isMobile) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("searchbox", { name: "Search the manual" }).fill("hedging");
    const results = page.getByRole("navigation", { name: "Search results" });
    await expect(results.getByText(/^\d+ pages?$/)).toBeVisible();
    await results.getByRole("link").first().click();
    await expect(page).toHaveURL(/\/architecture\/hedging$/);
    await expect(page.getByRole("searchbox", { name: "Search the manual" })).toHaveValue("");
    await page.goto(urls.internalDocs);
    if (isMobile) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("searchbox", { name: "Search the manual" }).fill("zzzz-no-such-word");
    await expect(page.getByText("Nothing matches “zzzz-no-such-word”.")).toBeVisible();
  });

  test("outline links jump to sections on wide screens", async ({ page, isMobile }) => {
    await page.goto(`${urls.internalDocs}/architecture/hedging`);
    const outline = page.getByRole("navigation", { name: "On this page" });
    if (isMobile) return expect(outline).toBeHidden();
    const first = outline.getByRole("link").first();
    const target = (await first.getAttribute("href"))!;
    await first.click();
    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(page.locator(target)).toBeInViewport();
  });

  test("unknown paths show a not-found page", async ({ page }) => {
    await page.goto(`${urls.internalDocs}/no/such/page`);
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    await page.getByRole("link", { name: "Go to the start page" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();
  });
});
